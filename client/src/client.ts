import { backoff } from "./backoff.ts";
import { CLOSE_REVOKED, type ClientMsg, type Holder, type LockScope, parse, type ServerMsg, VERSION } from "./protocol.ts";

export type State = "idle" | "connecting" | "open" | "waiting" | "revoked" | "stopped";

type Handler = (msg: ServerMsg) => void;

export interface ClientOptions {
  url: string;
  /** Injected in tests. */
  WebSocket?: typeof WebSocket;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  random?: () => number;
  debug?: (...args: unknown[]) => void;
  /**
   * Asks GLPI to recompute the grant of this session on `room` (ajax/grant.php), after
   * the server announced that rights on the item may have changed.
   */
  regrant?: (room: string) => Promise<unknown>;
  /** Clock (tests). */
  now?: () => number;
  /**
   * A GLPI request (ajax/session.php): GLPI issues a new token if Valkey lost ours (restart
   * without persistence). Resolves true when the GLPI session is alive, false when it ended.
   */
  refreshSession?: () => Promise<boolean>;
}

/** Connections refused in a row (401: token unknown) before asking GLPI for a new one. */
const REFUSED_BEFORE_REFRESH = 2;
/** At most one session refresh per this long (a real revocation must not loop). */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * One WebSocket per tab, shared by every feature. Rooms are remembered and
 * re-subscribed after each reconnection; the server re-checks grants every time.
 *
 * A room the server refuses after having accepted it is first granted again by GLPI (its
 * grant may have been lost with Valkey's data); refused again (rights lost), it is
 * forgotten and reported as `unsubscribed` with `reason: "forbidden"`.
 *
 * Valkey lost the session (restart without persistence): the server closes the socket as
 * revoked, or refuses it (401). GLPI is asked for a new token, then the tab reconnects;
 * if the GLPI session has ended, the tab stays disconnected.
 */
export class RealtimeClient {
  private _state: State = "idle";
  private readonly stateListeners = new Set<(s: State) => void>();
  /** Connection state; listeners (onState) hear each change. */
  get state(): State {
    return this._state;
  }
  set state(s: State) {
    if (s === this._state) return;
    this._state = s;
    for (const l of this.stateListeners) {
      try {
        l(s);
      } catch (e) {
        this.o.debug?.("realtime: state listener failed", e);
      }
    }
  }
  /** Whether the last attempt failed (reconnecting after a loss, not the first connection). */
  get retrying(): boolean {
    return this.attempt > 0;
  }
  onState(cb: (s: State) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }
  user: { id: number; name: string } | null = null;
  /** Id of the current connection (from `hello`). */
  conn: string | null = null;
  /** Lifetime of a fields lock on the server, seconds (from `hello`). */
  lockTtl = 30;

  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private nextId = 1;
  /** Tab activity; the server assumes `true` on each new connection. */
  private active = true;
  private readonly rooms = new Set<string>();
  /** Items whose presence a list page follows (`watch`), re-sent after reconnection. */
  private watched: string[] = [];
  /** Last `lock` state per room, for features that start after it arrived. */
  private readonly locks = new Map<string, Holder | null>();
  private readonly joined = new Set<string>();
  /** Rooms accepted at least once: a later refusal means the rights were lost. */
  private readonly accepted = new Set<string>();
  /** `sub` requests waiting for their reply: id → room. */
  private readonly pendingSubs = new Map<number, string>();
  /** Rooms refused once since their grant was asked again (a second refusal: lost). */
  private readonly regranted = new Set<string>();
  /** Sockets closed in a row before their `hello` (refused handshakes). */
  private refused = 0;
  private lastRefresh = -Infinity;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly o: Required<Omit<ClientOptions, "debug" | "regrant" | "refreshSession" | "now">> &
    Pick<ClientOptions, "debug" | "regrant" | "refreshSession"> & { now: () => number };

  constructor(opts: ClientOptions) {
    this.o = {
      WebSocket: globalThis.WebSocket,
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as number),
      random: Math.random,
      now: () => Date.now(),
      ...opts,
    };
  }

  start(): void {
    if (this.state === "idle" || this.state === "stopped") this.connect();
  }

  stop(): void {
    this.state = "stopped";
    if (this.timer !== null) this.o.clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close(1000);
    this.ws = null;
  }

  /** Message type ("hello", "subscribed", "error", ...) or "*" for all. */
  on(type: string, h: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(h);
    return () => set.delete(h);
  }

  subscribe(room: string): void {
    if (this.rooms.has(room)) return;
    this.rooms.add(room);
    if (this.state === "open") this.sub(room);
  }

  unsubscribe(room: string): void {
    if (!this.rooms.delete(room)) return;
    this.joined.delete(room);
    this.accepted.delete(room);
    if (this.state === "open") this.send({ t: "unsub", room });
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (this.state === "open") this.send({ t: "activity", active });
  }

  /** Takes or renews a lock of a joined room (fields: editor.ts, solution: timeline.ts). */
  lock(room: string, force = false, scope: LockScope = "fields", reason?: "solution" | "pending"): void {
    if (this.state === "open" && this.joined.has(room)) {
      this.send({ t: "lock", room, ...(force ? { force } : {}), ...(scope !== "fields" ? { scope } : {}), ...(reason ? { reason } : {}) });
    }
  }

  unlock(room: string, scope: LockScope = "fields"): void {
    if (this.state === "open" && this.joined.has(room)) this.send({ t: "unlock", room, ...(scope !== "fields" ? { scope } : {}) });
  }

  /** What this tab writes in the room's timeline (null: nothing). */
  compose(room: string, kind: string | null): void {
    if (this.state === "open" && this.joined.has(room)) this.send({ t: "compose", room, kind });
  }

  /** Follows the presence of list rows without being in them (replaces the set). */
  watch(rooms: string[]): void {
    this.watched = rooms;
    if (this.state === "open") this.send({ t: "watch", rooms });
  }

  isWatched(room: string): boolean {
    return this.watched.includes(room);
  }

  lockOf(room: string): Holder | null {
    return this.locks.get(room) ?? null;
  }

  /** Items this tab follows (subscribed, joined or not). */
  followed(): string[] {
    return [...this.rooms];
  }

  isJoined(room: string): boolean {
    return this.joined.has(room);
  }

  /** Sends a message on the open socket; returns its id (replies and errors echo it). */
  send(msg: ClientMsg): number {
    const id = this.nextId++;
    this.ws?.send(JSON.stringify({ v: VERSION, id, ...msg }));
    return id;
  }

  private sub(room: string): void {
    this.pendingSubs.set(this.send({ t: "sub", room }), room);
  }

  /** The server withholds events until GLPI rewrote our grant and we subscribe again. */
  private async regrant(room: string, ws: WebSocket): Promise<void> {
    this.regranted.add(room); // refused once more after this: the rights are gone
    try {
      await this.o.regrant?.(room);
    } catch (e) {
      this.o.debug?.("realtime: regrant failed", e);
    }
    // The server decides: subscribed again, or forbidden.
    if (ws === this.ws && this.state === "open" && this.rooms.has(room)) this.sub(room);
  }

  private lost(room: string): void {
    const known = this.accepted.has(room);
    this.rooms.delete(room);
    this.joined.delete(room);
    this.accepted.delete(room);
    if (known) this.emit({ v: VERSION, t: "unsubscribed", room, reason: "forbidden" });
  }

  private connect(): void {
    this.timer = null;
    this.state = "connecting";
    let ws: WebSocket;
    try {
      ws = new this.o.WebSocket(this.o.url);
    } catch (e) {
      this.o.debug?.("realtime: cannot open", e);
      return this.retry();
    }
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = (ev) => this.onClose(ws, ev.code);
    // onerror is always followed by onclose.
  }

  private onMessage(data: unknown): void {
    const msg = parse(data);
    if (!msg) return;
    switch (msg.t) {
      case "hello":
        this.attempt = 0;
        this.refused = 0;
        this.state = "open"; // listeners see it no longer retrying
        this.user = msg.user;
        this.conn = msg.conn;
        if (msg.lock_ttl) this.lockTtl = msg.lock_ttl;
        this.joined.clear();
        this.pendingSubs.clear();
        // Before subscribing, so that our presence entries carry the right state.
        if (!this.active) this.send({ t: "activity", active: false });
        for (const room of this.rooms) this.sub(room);
        if (this.watched.length) this.send({ t: "watch", rooms: this.watched });
        break;
      case "subscribed":
        if (msg.id !== undefined) this.pendingSubs.delete(msg.id);
        this.regranted.delete(msg.room);
        if (this.rooms.has(msg.room)) {
          this.joined.add(msg.room);
          this.accepted.add(msg.room);
        }
        break;
      case "unsubscribed":
        if (msg.reason === "forbidden") {
          this.lost(msg.room);
          return; // emitted by lost()
        }
        this.joined.delete(msg.room);
        break;
      case "lock":
        if (msg.scope === "fields") this.locks.set(msg.room, msg.holder);
        break;
      case "regrant":
        if (this.ws && this.rooms.has(msg.room)) void this.regrant(msg.room, this.ws);
        break;
      case "error": {
        this.o.debug?.("realtime:", msg.code, msg.message);
        const room = msg.id !== undefined ? this.pendingSubs.get(msg.id) : undefined;
        if (room !== undefined) {
          this.pendingSubs.delete(msg.id!);
          if (msg.code === "forbidden") {
            // Accepted before: GLPI grants it again (lost with Valkey's data?), once.
            if (this.accepted.has(room) && !this.regranted.has(room) && this.o.regrant && this.ws) {
              void this.regrant(room, this.ws);
            } else {
              this.lost(room);
            }
          }
        }
        break;
      }
    }
    this.emit(msg);
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return; // a previous socket
    const greeted = this.state === "open";
    this.ws = null;
    this.joined.clear();
    this.pendingSubs.clear();
    if (this.state === "stopped") return;
    if (code === CLOSE_REVOKED) {
      // GLPI session ended or changed, or Valkey lost it: GLPI decides.
      return void this.refresh(true);
    }
    this.refused = greeted ? 0 : this.refused + 1;
    if (this.refused >= REFUSED_BEFORE_REFRESH) return void this.refresh(false);
    this.retry();
  }

  /**
   * Asks GLPI for a new token (ajax/session.php), then reconnects. Without GLPI session,
   * or asked too recently: revoked (after a revocation) or the usual backoff.
   */
  private async refresh(revoked: boolean): Promise<void> {
    const now = this.o.now();
    let alive = false;
    if (this.o.refreshSession && now - this.lastRefresh >= REFRESH_INTERVAL_MS) {
      this.lastRefresh = now;
      this.state = "waiting";
      try {
        alive = await this.o.refreshSession();
      } catch (e) {
        this.o.debug?.("realtime: session refresh failed", e);
      }
      if ((this.state as State) === "stopped") return; // stopped while GLPI answered
    }
    if (alive) {
      this.refused = 0;
      this.attempt = 0;
      return this.retry();
    }
    if (revoked) {
      this.state = "revoked"; // the next GLPI page issues a new token
      return;
    }
    this.retry();
  }

  private retry(): void {
    const delay = backoff(this.attempt++, this.o.random);
    this.state = "waiting"; // after counting the attempt: listeners see it as retrying
    this.o.debug?.(`realtime: reconnecting in ${delay} ms`);
    this.timer = this.o.setTimeout(() => this.connect(), delay);
  }

  private emit(msg: ServerMsg): void {
    for (const key of [msg.t, "*"]) {
      for (const h of this.handlers.get(key) ?? []) {
        try {
          h(msg);
        } catch (e) {
          this.o.debug?.("realtime: handler failed", e);
        }
      }
    }
  }
}

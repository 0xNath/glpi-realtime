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
}

/**
 * One WebSocket per tab, shared by every feature. Rooms are remembered and
 * re-subscribed after each reconnection; the server re-checks grants every time.
 *
 * A room the server refuses after having accepted it (rights lost) is forgotten and
 * reported as `unsubscribed` with `reason: "forbidden"`.
 */
export class RealtimeClient {
  state: State = "idle";
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
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly o: Required<Omit<ClientOptions, "debug" | "regrant">> & Pick<ClientOptions, "debug" | "regrant">;

  constructor(opts: ClientOptions) {
    this.o = {
      WebSocket: globalThis.WebSocket,
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as number),
      random: Math.random,
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
        this.state = "open";
        this.attempt = 0;
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
          if (msg.code === "forbidden") this.lost(room);
        }
        break;
      }
    }
    this.emit(msg);
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return; // a previous socket
    this.ws = null;
    this.joined.clear();
    this.pendingSubs.clear();
    if (this.state === "stopped") return;
    if (code === CLOSE_REVOKED) {
      // GLPI session ended or changed: the next GLPI page issues a new token.
      this.state = "revoked";
      return;
    }
    this.retry();
  }

  private retry(): void {
    this.state = "waiting";
    const delay = backoff(this.attempt++, this.o.random);
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

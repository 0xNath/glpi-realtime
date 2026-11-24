import { backoff } from "./backoff.ts";
import { CLOSE_REVOKED, type ClientMsg, parse, type ServerMsg, VERSION } from "./protocol.ts";

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
}

/**
 * One WebSocket per tab, shared by every feature. Rooms are remembered and
 * re-subscribed after each reconnection; the server re-checks grants every time.
 */
export class RealtimeClient {
  state: State = "idle";
  user: { id: number; name: string } | null = null;

  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private nextId = 1;
  /** Tab activity; the server assumes `true` on each new connection. */
  private active = true;
  private readonly rooms = new Set<string>();
  private readonly joined = new Set<string>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly o: Required<Omit<ClientOptions, "debug">> & Pick<ClientOptions, "debug">;

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
    if (this.state === "open") this.send({ t: "sub", room });
  }

  unsubscribe(room: string): void {
    if (!this.rooms.delete(room)) return;
    this.joined.delete(room);
    if (this.state === "open") this.send({ t: "unsub", room });
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (this.state === "open") this.send({ t: "activity", active });
  }

  isJoined(room: string): boolean {
    return this.joined.has(room);
  }

  private send(msg: ClientMsg): void {
    this.ws?.send(JSON.stringify({ v: VERSION, id: this.nextId++, ...msg }));
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
        this.joined.clear();
        // Before subscribing, so that our presence entries carry the right state.
        if (!this.active) this.send({ t: "activity", active: false });
        for (const room of this.rooms) this.send({ t: "sub", room });
        break;
      case "subscribed":
        if (this.rooms.has(msg.room)) this.joined.add(msg.room);
        break;
      case "unsubscribed":
        this.joined.delete(msg.room);
        break;
      case "error":
        this.o.debug?.("realtime:", msg.code, msg.message);
        break;
    }
    this.emit(msg);
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return; // a previous socket
    this.ws = null;
    this.joined.clear();
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

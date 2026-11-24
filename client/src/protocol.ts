/** Protocol v1, see docs/protocol.md. */
export const VERSION = 1;

export type ErrorCode =
  | "bad_request"
  | "unsupported_version"
  | "forbidden"
  | "rate_limited"
  | "too_many_rooms"
  | "internal";

export type ByeReason = "revoked" | "shutdown" | "policy" | "slow" | "idle";

export type ServerMsg =
  | { v: 1; id?: number; t: "hello"; conn: string; user: { id: number; name: string }; ping_interval: number }
  | { v: 1; id?: number; t: "subscribed"; room: string }
  | { v: 1; id?: number; t: "unsubscribed"; room: string }
  | { v: 1; id?: number; t: "pong" }
  | { v: 1; id?: number; t: "error"; code: ErrorCode; message: string }
  | { v: 1; id?: number; t: "bye"; reason: ByeReason }
  | { v: 1; id?: number; t: "presence"; room: string; users: PresenceUser[] };

export interface PresenceUser {
  id: number;
  name: string;
  /** Unix seconds. */
  since: number;
  /** Active on at least one of their tabs. */
  active: boolean;
  /** As GLPI draws it; absent for old sessions. */
  avatar?: Avatar;
}

export interface Avatar {
  /** Same-origin path of the picture, empty when GLPI draws initials. */
  picture: string;
  initials: string;
  color: string;
  fg: string;
}

export type ClientMsg =
  | { t: "sub"; room: string }
  | { t: "unsub"; room: string }
  | { t: "ping" }
  | { t: "activity"; active: boolean };

/** Close code meaning "session revoked": do not reconnect before a new GLPI page load. */
export const CLOSE_REVOKED = 4001;

export function parse(data: unknown): ServerMsg | null {
  if (typeof data !== "string") return null;
  try {
    const m = JSON.parse(data);
    return m && m.v === VERSION && typeof m.t === "string" ? (m as ServerMsg) : null;
  } catch {
    return null;
  }
}

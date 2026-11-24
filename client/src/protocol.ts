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
  | { v: 1; id?: number; t: "hello"; conn: string; user: { id: number; name: string }; ping_interval: number; lock_ttl?: number }
  | { v: 1; id?: number; t: "subscribed"; room: string }
  /** `reason` is set when the server removed the subscription itself (rights lost). */
  | { v: 1; id?: number; t: "unsubscribed"; room: string; reason?: "forbidden" }
  | { v: 1; id?: number; t: "pong" }
  | { v: 1; id?: number; t: "error"; code: ErrorCode; message: string }
  | { v: 1; id?: number; t: "bye"; reason: ByeReason }
  | { v: 1; id?: number; t: "presence"; room: string; users: PresenceUser[] }
  | ({ v: 1; id?: number; t: "event"; room: string; by: Actor } & ItemEvent)
  | { v: 1; id?: number; t: "regrant"; room: string }
  /** Who edits the item's fields; null: nobody. */
  | { v: 1; id?: number; t: "lock"; room: string; scope: LockScope; holder: Holder | null }
  /** The user's notifications changed: refresh the bell. `alert`: ring in this tab. */
  | { v: 1; id?: number; t: "notification"; nid: string; kind: string; room: string; by: Actor; alert: boolean };

/** `fields`: the item's fields panel; `solution`: writing a solution. */
export type LockScope = "fields" | "solution";

export interface Holder {
  /** Connection id: ours when it equals the `conn` of our `hello`. */
  conn: string;
  id: number;
  name: string;
  /** Unix seconds. */
  since: number;
  avatar?: Avatar;
}

/** Who did it; id 0 for GLPI itself (crons, mail collector). */
export interface Actor {
  id: number;
  name: string;
}

/** Something changed on an item. No content: reload from GLPI to see it. */
export interface ItemEvent {
  /** `item.update`, `followup.add`, `task.delete`, `actor.add`, ... */
  kind: string;
  item?: { type: string; id: number };
  /** Changed fields, for `item.update`. */
  fields?: string[];
}

export interface PresenceUser {
  id: number;
  name: string;
  /** Unix seconds. */
  since: number;
  /** Active on at least one of their tabs. */
  active: boolean;
  /** As GLPI draws it; absent for old sessions. */
  avatar?: Avatar;
  /** Answer they are writing in the timeline: followup, task, solution... */
  composing?: string;
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
  | { t: "activity"; active: boolean }
  | { t: "lock"; room: string; force?: boolean; scope?: LockScope }
  | { t: "unlock"; room: string; scope?: LockScope }
  | { t: "compose"; room: string; kind: string | null };

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

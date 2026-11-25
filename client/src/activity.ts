/**
 * "Active on this tab" = the page is visible, has the focus (including inside an iframe
 * such as GLPI's rich-text editor) and received some input within `idleMs`.
 * Changes are reported after `settleMs` of stability, so that a quick Alt+Tab does not
 * make the ring blink for everyone.
 */
export interface ActivityOptions {
  doc: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener">;
  win: Pick<Window, "addEventListener">;
  onChange: (active: boolean) => void;
  idleMs?: number;
  settleMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart"] as const;

export class ActivityTracker {
  /** Last state reported through onChange. */
  reported: boolean;
  private lastInput: number;
  private idleTimer: unknown = null;
  private settleTimer: unknown = null;
  private readonly o: Required<ActivityOptions>;

  constructor(opts: ActivityOptions) {
    this.o = {
      idleMs: 5 * 60_000,
      // Long enough for focus moving into the editor's iframe (blur, then focus inside,
      // within a few ms) not to flicker; short enough to feel immediate to others.
      settleMs: 200,
      now: () => Date.now(),
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as number),
      ...opts,
    };
    this.lastInput = this.o.now();
    this.reported = this.compute();

    const check = () => this.schedule();
    this.o.doc.addEventListener("visibilitychange", check);
    this.o.win.addEventListener("focus", check);
    // On blur, focus may have moved into an iframe of the page: re-check once it settled.
    this.o.win.addEventListener("blur", () => this.o.setTimeout(check, 0));
    for (const ev of INPUT_EVENTS) {
      this.o.win.addEventListener(ev, () => this.input(), { passive: true, capture: true });
    }
    this.armIdle();
  }

  compute(): boolean {
    return (
      this.o.doc.visibilityState === "visible" &&
      this.o.doc.hasFocus() &&
      this.o.now() - this.lastInput < this.o.idleMs
    );
  }

  private input(): void {
    const wasIdle = this.o.now() - this.lastInput >= this.o.idleMs;
    this.lastInput = this.o.now();
    this.armIdle();
    if (wasIdle) this.schedule();
  }

  private armIdle(): void {
    if (this.idleTimer !== null) this.o.clearTimeout(this.idleTimer);
    this.idleTimer = this.o.setTimeout(() => {
      this.idleTimer = null;
      this.schedule();
    }, this.o.idleMs);
  }

  /** Reports the state once it has been stable for settleMs. */
  private schedule(): void {
    if (this.settleTimer !== null) this.o.clearTimeout(this.settleTimer);
    this.settleTimer = this.o.setTimeout(() => {
      this.settleTimer = null;
      const now = this.compute();
      if (now !== this.reported) {
        this.reported = now;
        this.o.onChange(now);
      }
    }, this.o.settleMs);
  }
}

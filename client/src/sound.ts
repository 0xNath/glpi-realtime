/**
 * Short two-tone chime, synthesized (no audio file). Browsers only allow sound after a
 * user gesture on the page: the context is created on the first click or key press.
 */
export class Chime {
  private ctx: AudioContext | null = null;
  private last = 0;

  constructor(win: Window = window) {
    const unlock = () => {
      try {
        const AC = (win as any).AudioContext ?? (win as any).webkitAudioContext;
        if (AC && !this.ctx) this.ctx = new AC();
        void this.ctx?.resume?.();
      } catch {
        /* no audio */
      }
    };
    win.addEventListener("click", unlock, { once: true, capture: true });
    win.addEventListener("keydown", unlock, { once: true, capture: true });
  }

  play(): void {
    const ctx = this.ctx;
    // At most one chime every 2 s, however many notifications arrive.
    if (!ctx || ctx.state !== "running" || Date.now() - this.last < 2000) return;
    this.last = Date.now();
    const t0 = ctx.currentTime;
    for (const [freq, at] of [[880, 0], [1320, 0.12]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.15, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.4);
    }
  }
}

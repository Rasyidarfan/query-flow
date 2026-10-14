/** Sliding-window limiter: at most `max` acquisitions in any `windowMs` interval. */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
  ) {}

  /** Milliseconds until the next acquisition is allowed (0 when available now). */
  waitTime(): number {
    this.prune();
    if (this.stamps.length < this.max) return 0;
    return Math.max(0, (this.stamps[0] ?? 0) + this.windowMs - this.now());
  }

  async acquire(signal?: AbortSignal, onWait?: (ms: number) => void): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error("Run dihentikan oleh pengguna.");
      const wait = this.waitTime();
      if (wait === 0) {
        this.stamps.push(this.now());
        return;
      }
      onWait?.(wait);
      await this.sleep(Math.min(wait, 1000), signal);
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length && (this.stamps[0] ?? 0) <= cutoff) this.stamps.shift();
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(new Error("Run dihentikan oleh pengguna."));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

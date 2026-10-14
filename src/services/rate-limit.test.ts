import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

function fakeClock() {
  let time = 0;
  const waits: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    waits,
    advance: (ms: number) => { time += ms; },
  };
}

describe("RateLimiter", () => {
  it("allows max acquisitions per window without waiting", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(30, 60_000, clock.now, clock.sleep);
    for (let i = 0; i < 30; i++) await limiter.acquire();
    expect(clock.waits).toEqual([]);
    expect(limiter.waitTime()).toBe(60_000);
  });

  it("waits until the oldest acquisition leaves the window", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, 60_000, clock.now, clock.sleep);
    await limiter.acquire();
    clock.advance(10_000);
    await limiter.acquire();
    const waited: number[] = [];
    await limiter.acquire(undefined, (ms) => waited.push(ms));
    expect(clock.now()).toBe(60_000);
    expect(waited[0]).toBe(50_000);
  });

  it("never exceeds the limit in any rolling window", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(30, 60_000, clock.now, clock.sleep);
    const stamps: number[] = [];
    for (let i = 0; i < 95; i++) {
      await limiter.acquire();
      stamps.push(clock.now());
      clock.advance(100);
    }
    for (const start of stamps) {
      expect(stamps.filter((stamp) => stamp >= start && stamp < start + 60_000).length).toBeLessThanOrEqual(30);
    }
  });

  it("stops waiting when aborted", async () => {
    const limiter = new RateLimiter(1, 60_000);
    await limiter.acquire();
    const controller = new AbortController();
    const pending = limiter.acquire(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("dihentikan");
  });
});

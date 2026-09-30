/**
 * A per-connection message budget: a token bucket.
 *
 * `take()` spends one token for a received frame and says how long to stop reading, if the
 * bucket is now empty (0 = keep reading). Time is passed in, so it is testable without clocks.
 */
export class MessageBudget {
  private tokens: number;
  private last: number;
  /** Frames that arrived while the budget was spent (for the log). */
  throttled = 0;

  constructor(private readonly perSecond: number, private readonly burst: number, now = Date.now()) {
    this.tokens = burst;
    this.last = now;
  }

  private refill(now: number) {
    const dt = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + dt * this.perSecond);
    this.last = now;
  }

  /** Spend one token; returns the milliseconds to pause reading (0: carry on). */
  take(now = Date.now()): number {
    if (!(this.perSecond > 0) || !(this.burst > 0)) return 0; // disabled
    this.refill(now);
    this.tokens -= 1;
    if (this.tokens >= 1) return 0;
    this.throttled++;
    // Until one whole token is back.
    return Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
  }
}

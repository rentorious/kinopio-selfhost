/**
 * Tiny in-memory sliding-window limiter. One instance per process is fine:
 * this runs as a single Railway service.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor (private readonly max: number, private readonly windowMs: number) {}

  /** Record an attempt; returns false when the key is over the limit. */
  attempt (key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs)
    if (recent.length >= this.max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) this.prune(now)
    return true
  }

  reset (key: string): void {
    this.hits.delete(key)
  }

  private prune (now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every(t => now - t >= this.windowMs)) this.hits.delete(key)
    }
  }
}

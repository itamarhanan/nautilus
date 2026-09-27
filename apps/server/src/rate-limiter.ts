import type { IncomingMessage } from "node:http";

type Entry = {
  count: number;
  resetAt: number;
};

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  consume(key: string): boolean {
    const timestamp = Date.now();
    this.prune(timestamp);
    const current = this.entries.get(key);
    if (!current || current.resetAt <= timestamp) {
      this.entries.set(key, { count: 1, resetAt: timestamp + this.windowMs });
      this.trim();
      return true;
    }
    if (current.count >= this.limit) {
      return false;
    }
    current.count += 1;
    this.entries.delete(key);
    this.entries.set(key, current);
    return true;
  }

  isLimited(key: string): boolean {
    const current = this.entries.get(key);
    return current !== undefined && current.resetAt > Date.now() && current.count >= this.limit;
  }

  recordFailure(key: string): void {
    if (this.isLimited(key)) {
      return;
    }
    this.consume(key);
  }

  private prune(timestamp: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= timestamp) {
        this.entries.delete(key);
      }
    }
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.entries.delete(oldest);
    }
  }
}

export function requestRateKey(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return (forwarded.split(",", 1)[0] ?? "").trim();
  }
  return request.socket.remoteAddress ?? "unknown";
}

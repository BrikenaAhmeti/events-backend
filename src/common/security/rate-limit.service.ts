import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../errors/application.error';

type WindowEntry = { count: number; resetsAt: number };

@Injectable()
export class RateLimitService {
  private readonly entries = new Map<string, WindowEntry>();

  assert(key: string, limit: number, windowMs: number): void {
    const now = Date.now();
    if (this.entries.size >= 10_000) this.compact(now);
    const existing = this.entries.get(key);
    const entry =
      !existing || existing.resetsAt <= now ? { count: 0, resetsAt: now + windowMs } : existing;
    entry.count += 1;
    this.entries.set(key, entry);
    if (entry.count > limit) {
      throw new ApplicationError(429, 'RATE_LIMITED', 'Please wait before trying again.', {
        retryAfterSeconds: Math.ceil((entry.resetsAt - now) / 1000),
      });
    }
  }

  private compact(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetsAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= 10_000) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

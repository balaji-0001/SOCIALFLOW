import type { NextFunction, Request, Response } from "express";
import { jsonError } from "../lib/http-errors";

// A minimal in-memory, fixed-window rate limiter. No new dependency, in
// keeping with this project's preference for built-in tools (see
// lib/password.ts using node:crypto scrypt instead of bcrypt/argon2).
//
// Limitation: state is per-process, so it resets on restart and isn't
// shared across multiple server instances. That's acceptable for the
// current single-instance deployment; a multi-instance deployment should
// replace this with a shared store (e.g. Redis) keyed the same way.

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(options: { windowMs: number; max: number; keyPrefix: string }) {
  const buckets = new Map<string, Bucket>();

  // Periodically drop expired entries so long-lived processes don't
  // accumulate one bucket per distinct IP forever.
  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    },
    Math.max(options.windowMs, 60_000),
  );
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${options.keyPrefix}:${req.ip ?? "unknown"}`;
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (existing.count >= options.max) {
      const retryAfterSeconds = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      jsonError(res, 429, "rate_limited", "Too many attempts. Try again in a few minutes.");
      return;
    }
    existing.count += 1;
    next();
  };
}

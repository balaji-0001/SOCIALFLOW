import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { rateLimit } from "./rate-limit";

function fakeReqRes(ip: string) {
  const req = { ip } as Request;
  const json = vi.fn();
  const setHeader = vi.fn();
  const res = { status: vi.fn(() => ({ json })), setHeader } as unknown as Response;
  return { req, res, json };
}

describe("rateLimit", () => {
  it("allows requests under the limit and blocks once it's exceeded", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3, keyPrefix: "test" });
    const { req, res } = fakeReqRes("1.2.3.4");
    const next = vi.fn();

    limiter(req, res, next);
    limiter(req, res, next);
    limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(3);

    limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(3); // not called a 4th time
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  it("tracks separate clients independently", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: "test" });
    const next = vi.fn();
    const a = fakeReqRes("1.1.1.1");
    const b = fakeReqRes("2.2.2.2");

    limiter(a.req, a.res, next);
    limiter(b.req, b.res, next);
    expect(next).toHaveBeenCalledTimes(2);

    limiter(a.req, a.res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(a.res.status).toHaveBeenCalledWith(429);
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    try {
      const limiter = rateLimit({ windowMs: 1000, max: 1, keyPrefix: "test" });
      const { req, res } = fakeReqRes("9.9.9.9");
      const next = vi.fn();

      limiter(req, res, next);
      limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1001);
      limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

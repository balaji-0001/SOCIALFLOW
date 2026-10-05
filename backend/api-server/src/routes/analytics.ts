import { Router, type IRouter } from "express";
import { requireAccess } from "../lib/access";
import { buildReport, resolveRange, type RangeKey } from "../lib/analytics-report";
import { collectWorkspace } from "../lib/analytics";
import { jsonError } from "../lib/http-errors";
import { platforms, type Platform } from "../lib/oauth/types";
import { isValidTimeZone } from "../lib/time";
import { rateLimit } from "../middlewares/rate-limit";

/* Analytics: reads what the collector stored, and lets editors refresh on demand. */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGES: RangeKey[] = ["today", "7d", "30d", "90d", "custom"];

const refreshLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: Number(process.env.ANALYTICS_REFRESH_RATE_LIMIT ?? 5), keyPrefix: "analytics:refresh" });

router.get("/analytics", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "analytics:read");
  if (!ctx) return;
  const key = (typeof req.query.range === "string" ? req.query.range : "30d") as RangeKey;
  if (!RANGES.includes(key)) return jsonError(res, 400, "invalid_query", "Range must be today, 7d, 30d, 90d or custom.");
  const tz = typeof req.query.tz === "string" && isValidTimeZone(req.query.tz) ? req.query.tz : "UTC";
  const range = resolveRange(key, tz, { from: typeof req.query.from === "string" ? req.query.from : undefined, to: typeof req.query.to === "string" ? req.query.to : undefined });
  if (!range) return jsonError(res, 400, "invalid_query", "Pick a start and end date (YYYY-MM-DD), up to 400 days.");
  const platform = typeof req.query.platform === "string" && req.query.platform ? req.query.platform : undefined;
  if (platform && !(platforms as readonly string[]).includes(platform)) return jsonError(res, 400, "invalid_query", "Unknown platform.");
  const accountId = typeof req.query.accountId === "string" && req.query.accountId ? req.query.accountId : undefined;
  if (accountId && !UUID.test(accountId)) return jsonError(res, 400, "invalid_query", "Unknown account.");
  res.json(await buildReport(ctx.workspaceId, range, { platform: platform as Platform | undefined, accountId }, tz));
});

/** Reads the networks now instead of waiting for the next scheduled collection. */
router.post("/analytics/refresh", refreshLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "analytics:refresh");
  if (!ctx) return;
  const accountId = typeof req.body?.accountId === "string" && UUID.test(req.body.accountId) ? req.body.accountId : undefined;
  const outcomes = await collectWorkspace(ctx.workspaceId, { force: true, accountIds: accountId ? [accountId] : undefined });
  res.json({ results: outcomes.map((outcome) => ({ accountId: outcome.accountId, ok: outcome.ok, skipped: outcome.skipped ?? false, postsRead: outcome.postsRead, error: outcome.error ?? null, notes: outcome.notes })) });
});

export default router;

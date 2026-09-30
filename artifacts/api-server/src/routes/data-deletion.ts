import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { connectedAccountsTable, dataDeletionsTable, db } from "@workspace/db";
import { recordAudit } from "../lib/audit";
import { jsonError } from "../lib/http-errors";
import { verifySignedRequest } from "../lib/meta-signed-request";
import { getRedirectBaseUrl } from "../lib/oauth/config";
import { rateLimit } from "../middlewares/rate-limit";

/*
 * Meta's "data deletion callback": when someone removes SocialFlow in their Facebook or Instagram settings and asks
 * for their data to be deleted, Meta POSTs a signed request here. We verify it with the matching app secret, delete
 * the connected accounts that person authorised (this removes the encrypted tokens and the accounts' post records),
 * and answer with a confirmation code and a page where they can check the result. Public on purpose (Meta calls it,
 * not a signed-in user); the signature is what authorises it.
 */

const router: IRouter = Router();
const limiter = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: "data-deletion" });

// Which network a request is about is decided by which app secret verifies it.
const secrets: Array<{ platform: "facebook" | "instagram"; env: string }> = [
  { platform: "facebook", env: "FACEBOOK_APP_SECRET" },
  { platform: "instagram", env: "INSTAGRAM_APP_SECRET" },
];

router.post("/data-deletion/meta", limiter, async (req, res): Promise<void> => {
  const signedRequest = (req.body as Record<string, unknown> | undefined)?.signed_request;
  let platform: "facebook" | "instagram" | null = null;
  let userId: string | null = null;
  for (const candidate of secrets) {
    const payload = verifySignedRequest(signedRequest, process.env[candidate.env]?.trim() ?? "");
    if (payload) {
      platform = candidate.platform;
      userId = typeof payload.user_id === "string" && payload.user_id.length > 0 && payload.user_id.length <= 64 ? payload.user_id : null;
      break;
    }
  }
  if (!platform || !userId) return jsonError(res, 400, "invalid_request", "The request couldn't be verified.");

  const removed = await db
    .delete(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.platform, platform), eq(connectedAccountsTable.authorizedByExternalUserId, userId)))
    .returning({ workspaceId: connectedAccountsTable.workspaceId });

  for (const workspaceId of new Set(removed.map((row) => row.workspaceId))) {
    await recordAudit({ workspaceId, actorUserId: null, action: "account.data_deleted", target: platform, detail: { via: "meta_data_deletion_callback" } });
  }

  const code = randomBytes(8).toString("hex").toUpperCase();
  await db.insert(dataDeletionsTable).values({ confirmationCode: code, platform, externalUserId: userId, accountsRemoved: removed.length, status: "completed", completedAt: new Date() });
  const base = getRedirectBaseUrl() ?? `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base}/data-deletion?code=${code}`, confirmation_code: code });
});

// A plain GET describes the endpoint, so a dashboard that checks the address with a GET sees a live page, not a 404.
router.get("/data-deletion/meta", limiter, (_req, res): void => {
  res.json({ endpoint: "SocialFlow data deletion callback", method: "POST", accepts: "signed_request (Meta)", status: "ready" });
});

router.get("/data-deletion/status/:code", limiter, async (req, res): Promise<void> => {
  const code = String(req.params.code ?? "").toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(code)) return jsonError(res, 404, "not_found", "No deletion request has that code.");
  const [row] = await db.select().from(dataDeletionsTable).where(eq(dataDeletionsTable.confirmationCode, code)).limit(1);
  if (!row) return jsonError(res, 404, "not_found", "No deletion request has that code.");
  res.json({ code: row.confirmationCode, status: row.status, accountsRemoved: row.accountsRemoved, requestedAt: row.requestedAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null });
});

export default router;

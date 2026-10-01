import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  automationItemsTable,
  automationKinds,
  automationsTable,
  connectedAccountsTable,
  db,
  postsTable,
  type Automation,
  type AutomationConfig,
  type AutomationKind,
} from "@workspace/db";
import { requireAccess } from "../lib/access";
import { recordAudit } from "../lib/audit";
import {
  automationStats,
  DEFAULT_TEMPLATE,
  latestRuns,
  MAX_AUTOMATIONS_PER_WORKSPACE,
  normalizeConfig,
  runAutomation,
} from "../lib/automations";
import { FeedError, feedErrorStatus, fetchSource, normalizeSourceUrl } from "../lib/feeds";
import { jsonError } from "../lib/http-errors";
import { rateLimit } from "../middlewares/rate-limit";

/*
 * Automations: WordPress auto-share and RSS/Atom feeds (see lib/automations.ts for how runs work).
 * automations:read (every role) lists and inspects; automations:manage (owner, admin, editor) changes them.
 */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 120;
const MAX_TEMPLATE = 2_000;
const MODES = ["publish", "queue", "draft"] as const;

const runNowLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: Number(process.env.AUTOMATION_RUN_RATE_LIMIT ?? 10), keyPrefix: "automations:run" });
const testSourceLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: Number(process.env.AUTOMATION_TEST_RATE_LIMIT ?? 30), keyPrefix: "automations:test" });

type Fields = { name: string; sourceUrl: string; config: AutomationConfig };

/** Validates a create body, or a patch merged onto `existing`. */
async function validate(body: Record<string, unknown>, workspaceId: string, kind: AutomationKind, existing?: Automation): Promise<{ fields: Fields } | { error: string }> {
  const has = (key: string) => body[key] !== undefined;
  const name = has("name") ? (typeof body.name === "string" ? body.name.trim() : "") : existing?.name ?? "";
  if (name.length < 1 || name.length > MAX_NAME) return { error: `Name must be 1 to ${MAX_NAME} characters.` };

  let sourceUrl = existing?.sourceUrl ?? "";
  if (has("sourceUrl") || !existing) {
    if (typeof body.sourceUrl !== "string") return { error: kind === "wordpress" ? "Enter your WordPress site's address." : "Enter the feed's address." };
    try {
      sourceUrl = normalizeSourceUrl(kind, body.sourceUrl);
    } catch (error) {
      return { error: error instanceof FeedError ? error.message : "Enter a full link that starts with http:// or https://." };
    }
  }

  const base = existing ? normalizeConfig(existing.config) : normalizeConfig({});
  const raw = body.config === undefined ? {} : body.config;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "The automation's settings aren't valid." };
  const patch = raw as Record<string, unknown>;
  const config: AutomationConfig = { ...base };

  if (patch.connectedAccountIds !== undefined) {
    if (!Array.isArray(patch.connectedAccountIds) || patch.connectedAccountIds.some((id) => typeof id !== "string" || !UUID.test(id))) return { error: "Choose the accounts to post to." };
    config.connectedAccountIds = [...new Set(patch.connectedAccountIds as string[])];
  }
  if (config.connectedAccountIds.length === 0) return { error: "Choose at least one account to post to." };
  if (config.connectedAccountIds.length > 50) return { error: "Choose at most 50 accounts." };
  const accounts = await db
    .select({ id: connectedAccountsTable.id, platform: connectedAccountsTable.platform, name: connectedAccountsTable.displayName })
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.workspaceId, workspaceId), inArray(connectedAccountsTable.id, config.connectedAccountIds)));
  if (accounts.length !== config.connectedAccountIds.length) return { error: "One or more selected accounts don't exist in this workspace." };
  const youtube = accounts.find((account) => account.platform === "youtube");
  if (youtube) return { error: `${youtube.name} is a YouTube channel. YouTube posts need a video, so it can't be used for automations.` };

  if (patch.mode !== undefined) {
    if (!MODES.includes(patch.mode as (typeof MODES)[number])) return { error: "Mode must be publish, queue or draft." };
    config.mode = patch.mode as AutomationConfig["mode"];
  }
  if (patch.template !== undefined) {
    if (typeof patch.template !== "string") return { error: "The post template isn't valid." };
    config.template = patch.template.trim() ? patch.template : DEFAULT_TEMPLATE;
  }
  if (config.template.length > MAX_TEMPLATE) return { error: `The post template can be up to ${MAX_TEMPLATE.toLocaleString()} characters.` };
  if (!config.template.includes("{url}") && !config.template.includes("{title}")) return { error: "The post template must include {title} or {url}." };
  if (patch.includeImage !== undefined) {
    if (typeof patch.includeImage !== "boolean") return { error: "includeImage must be true or false." };
    config.includeImage = patch.includeImage;
  }
  if (patch.maxPostsPerRun !== undefined) {
    if (typeof patch.maxPostsPerRun !== "number" || !Number.isInteger(patch.maxPostsPerRun) || patch.maxPostsPerRun < 1 || patch.maxPostsPerRun > 10) return { error: "Posts per check must be 1 to 10." };
    config.maxPostsPerRun = patch.maxPostsPerRun;
  }
  if (patch.postExistingOnFirstRun !== undefined) {
    if (typeof patch.postExistingOnFirstRun !== "boolean") return { error: "postExistingOnFirstRun must be true or false." };
    config.postExistingOnFirstRun = patch.postExistingOnFirstRun;
  }
  return { fields: { name, sourceUrl, config } };
}

async function serialize(rows: Automation[]) {
  if (rows.length === 0) return [];
  const stats = await automationStats(rows.map((row) => row.id));
  const accountIds = [...new Set(rows.flatMap((row) => normalizeConfig(row.config).connectedAccountIds))];
  const accounts = accountIds.length === 0 ? [] : await db
    .select({ id: connectedAccountsTable.id, workspaceId: connectedAccountsTable.workspaceId, name: connectedAccountsTable.displayName, platform: connectedAccountsTable.platform, avatarUrl: connectedAccountsTable.avatarUrl, status: connectedAccountsTable.status })
    .from(connectedAccountsTable)
    .where(inArray(connectedAccountsTable.id, accountIds));
  return rows.map((row) => {
    const config = normalizeConfig(row.config);
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      sourceUrl: row.sourceUrl,
      status: row.status,
      config,
      lastRunAt: row.lastRunAt,
      nextRunAt: row.status === "active" ? row.nextRunAt : null,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      consecutiveFailures: row.consecutiveFailures,
      postsCreatedTotal: stats.get(row.id)?.postsCreatedTotal ?? 0,
      accounts: config.connectedAccountIds
        .map((id) => accounts.find((account) => account.id === id && account.workspaceId === row.workspaceId))
        .filter((account): account is NonNullable<typeof account> => Boolean(account))
        .map(({ workspaceId: _workspaceId, ...account }) => account),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

async function findAutomation(id: string, workspaceId: string): Promise<Automation | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db.select().from(automationsTable).where(and(eq(automationsTable.id, id), eq(automationsTable.workspaceId, workspaceId)));
  return row ?? null;
}

const serializeRun = (run: Awaited<ReturnType<typeof latestRuns>>[number]) => ({
  id: run.id, automationId: run.automationId, startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status,
  itemsFound: run.itemsFound, itemsNew: run.itemsNew, postsCreated: run.postsCreated, error: run.error,
});

/** Fetches a source and shows its latest items, so the user can check the address before saving. */
router.post("/automations/test-source", testSourceLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:manage");
  if (!ctx) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!automationKinds.includes(body.kind as AutomationKind)) return jsonError(res, 400, "invalid_body", "Kind must be wordpress or rss.");
  if (typeof body.url !== "string") return jsonError(res, 400, "invalid_url", "Enter a full link that starts with http:// or https://.");
  const kind = body.kind as AutomationKind;
  try {
    const url = normalizeSourceUrl(kind, body.url);
    const result = await fetchSource(kind, url);
    res.json({
      ok: true,
      kind,
      url,
      sourceTitle: result.sourceTitle,
      items: result.items.slice(0, 5).map((item) => ({ title: item.title, url: item.url, publishedAt: item.publishedAt, imageUrl: item.imageUrl, excerpt: item.excerpt })),
    });
  } catch (error) {
    if (error instanceof FeedError) return jsonError(res, feedErrorStatus(error), error.code, error.message);
    req.log.error({ err: error }, "Testing an automation source failed");
    jsonError(res, 502, "fetch_failed", "The source couldn't be read.");
  }
});

router.get("/automations", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:read");
  if (!ctx) return;
  const rows = await db.select().from(automationsTable).where(eq(automationsTable.workspaceId, ctx.workspaceId)).orderBy(asc(automationsTable.createdAt));
  res.json({ automations: await serialize(rows), limit: MAX_AUTOMATIONS_PER_WORKSPACE });
});

router.post("/automations", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:manage");
  if (!ctx) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!automationKinds.includes(body.kind as AutomationKind)) return jsonError(res, 400, "invalid_body", "Kind must be wordpress or rss.");
  const kind = body.kind as AutomationKind;
  const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(automationsTable).where(eq(automationsTable.workspaceId, ctx.workspaceId));
  if (Number(count?.total ?? 0) >= MAX_AUTOMATIONS_PER_WORKSPACE) return jsonError(res, 400, "limit_reached", `A workspace can have up to ${MAX_AUTOMATIONS_PER_WORKSPACE} automations. Delete one to add another.`);
  const checked = await validate(body, ctx.workspaceId, kind);
  if ("error" in checked) return jsonError(res, 400, "invalid_body", checked.error);
  const { name, sourceUrl, config } = checked.fields;
  // Due straight away: the first run records what is already in the source (the baseline) within a minute.
  const [created] = await db.insert(automationsTable).values({ workspaceId: ctx.workspaceId, kind, name, sourceUrl, config, status: "active", nextRunAt: new Date(), createdByUserId: ctx.userId }).returning();
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "automation.create", target: created!.id, detail: { kind, name, mode: config.mode, accountCount: config.connectedAccountIds.length } });
  const [serialized] = await serialize([created!]);
  res.status(201).json(serialized);
});

router.get("/automations/:id", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:read");
  if (!ctx) return;
  const existing = await findAutomation(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Automation not found.");
  const [serialized] = await serialize([existing]);
  res.json(serialized);
});

router.patch("/automations/:id", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:manage");
  if (!ctx) return;
  const existing = await findAutomation(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Automation not found.");
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.kind !== undefined && body.kind !== existing.kind) return jsonError(res, 400, "invalid_body", "An automation's kind can't be changed. Create a new one instead.");
  const checked = await validate(body, ctx.workspaceId, existing.kind, existing);
  if ("error" in checked) return jsonError(res, 400, "invalid_body", checked.error);
  const { name, sourceUrl, config } = checked.fields;
  const sourceChanged = sourceUrl !== existing.sourceUrl;
  const [updated] = await db
    .update(automationsTable)
    .set({
      name, sourceUrl, config,
      // A new address is a new source: take a fresh baseline so its back catalogue isn't posted.
      ...(sourceChanged ? { baselineAt: null, consecutiveFailures: 0, lastError: null, nextRunAt: new Date() } : {}),
    })
    .where(and(eq(automationsTable.id, existing.id), eq(automationsTable.workspaceId, ctx.workspaceId)))
    .returning();
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "automation.update", target: existing.id, detail: { name, sourceChanged } });
  const [serialized] = await serialize([updated!]);
  res.json(serialized);
});

router.delete("/automations/:id", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:manage");
  if (!ctx) return;
  const existing = await findAutomation(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Automation not found.");
  // Posts it already made stay; only the automation and its history go.
  await db.delete(automationsTable).where(and(eq(automationsTable.id, existing.id), eq(automationsTable.workspaceId, ctx.workspaceId)));
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "automation.delete", target: existing.id, detail: { name: existing.name, kind: existing.kind } });
  res.status(204).end();
});

router.post("/automations/:id/pause", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:manage");
  if (!ctx) return;
  const existing = await findAutomation(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Automation not found.");
  const [updated] = await db.update(automationsTable).set({ status: "paused" }).where(eq(automationsTable.id, existing.id)).returning();
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "automation.pause", target: existing.id, detail: { name: existing.name } });
  const [serialized] = await serialize([updated!]);
  res.json(serialized);
});

router.post("/automations/:id/resume", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:manage");
  if (!ctx) return;
  const existing = await findAutomation(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Automation not found.");
  const [updated] = await db.update(automationsTable).set({ status: "active", consecutiveFailures: 0, nextRunAt: new Date() }).where(eq(automationsTable.id, existing.id)).returning();
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "automation.resume", target: existing.id, detail: { name: existing.name, previousStatus: existing.status } });
  const [serialized] = await serialize([updated!]);
  res.json(serialized);
});

/** Checks the source now (whatever the automation's status) and returns the run with the updated automation. */
router.post("/automations/:id/run-now", runNowLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:manage");
  if (!ctx) return;
  const existing = await findAutomation(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Automation not found.");
  const run = await runAutomation(existing.id);
  if (!run) return jsonError(res, 404, "not_found", "Automation not found.");
  const [after] = await db.select().from(automationsTable).where(eq(automationsTable.id, existing.id));
  const [serialized] = await serialize([after!]);
  res.json({ run: serializeRun(run), automation: serialized });
});

router.get("/automations/:id/runs", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:read");
  if (!ctx) return;
  const existing = await findAutomation(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Automation not found.");
  res.json({ runs: (await latestRuns(existing.id)).map(serializeRun) });
});

router.get("/automations/:id/items", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "automations:read");
  if (!ctx) return;
  const existing = await findAutomation(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Automation not found.");
  const rows = await db
    .select({
      id: automationItemsTable.id, itemKey: automationItemsTable.itemKey, title: automationItemsTable.title, url: automationItemsTable.url,
      publishedAt: automationItemsTable.publishedAt, status: automationItemsTable.status, postId: automationItemsTable.postId,
      postStatus: postsTable.status, postScheduledAt: postsTable.scheduledAt, attempts: automationItemsTable.attempts,
      error: automationItemsTable.error, createdAt: automationItemsTable.createdAt,
    })
    .from(automationItemsTable)
    .leftJoin(postsTable, eq(postsTable.id, automationItemsTable.postId))
    .where(eq(automationItemsTable.automationId, existing.id))
    .orderBy(desc(automationItemsTable.createdAt), desc(automationItemsTable.publishedAt))
    .limit(100);
  res.json({ items: rows.map((row) => ({ ...row, postStatus: row.postStatus ?? null, postScheduledAt: row.postScheduledAt ?? null })) });
});

export default router;

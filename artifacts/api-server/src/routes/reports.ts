import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { connectedAccountsTable, db, workspacesTable, type WorkspaceRole } from "@workspace/db";
import { requireAccess } from "../lib/access";
import { buildReport, resolveRange, type RangeKey } from "../lib/analytics-report";
import { recordAudit } from "../lib/audit";
import { jsonError } from "../lib/http-errors";
import { platforms, type Platform } from "../lib/oauth/types";
import { renderReportPdf, reportFileName } from "../lib/report-pdf";
import { computeNextRun, mapRun, mapSchedule, parseRecipients, runSchedule, type Frequency, type ScheduleRangeKey, type ScheduleRow } from "../lib/reports";
import { resolveWorkspace, type WorkspaceContext } from "../lib/session";
import { isValidTimeZone } from "../lib/time";
import { rateLimit } from "../middlewares/rate-limit";

/*
 * Analytics PDF export and scheduled email reports.
 * Permissions: reports:read (every role) and reports:manage (owner, admin, editor). They are enforced here with the
 * role table below until they are registered in lib/permissions.ts (docs/integration/reports.md); the PDF needs analytics:read.
 */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGES: RangeKey[] = ["today", "7d", "30d", "90d", "custom"];
const MANAGE_ROLES: WorkspaceRole[] = ["owner", "admin", "editor"];

const sendLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: Number(process.env.REPORTS_SEND_RATE_LIMIT ?? 5), keyPrefix: "reports:send" });

async function requireReports(req: Request, res: Response, level: "read" | "manage"): Promise<WorkspaceContext | null> {
  const ctx = await resolveWorkspace(req, res);
  if (!ctx) { jsonError(res, 401, "unauthorized", "Sign in to continue."); return null; }
  if (level === "manage" && !MANAGE_ROLES.includes(ctx.role)) { jsonError(res, 403, "forbidden", "Your role in this workspace doesn't allow that. Ask an owner or admin."); return null; }
  return ctx;
}

router.get("/analytics/report.pdf", async (req, res): Promise<void> => {
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
  const [workspace] = await db.select({ name: workspacesTable.name }).from(workspacesTable).where(eq(workspacesTable.id, ctx.workspaceId));
  const report = await buildReport(ctx.workspaceId, range, { platform: platform as Platform | undefined, accountId }, tz);
  const pdf = await renderReportPdf(report, { workspaceName: workspace?.name ?? "Workspace" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${reportFileName(report.range)}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", String(pdf.length));
  res.end(pdf);
});

type Fields = { name: string; frequency: Frequency; weekday: number | null; dayOfMonth: number | null; hour: number; timezone: string; rangeKey: ScheduleRangeKey; platform: string | null; accountId: string | null; recipients: string[]; enabled: boolean };

/** Validates a create body, or a patch merged onto `existing`. Returns fields or an error message. */
async function validate(body: Record<string, unknown>, workspaceId: string, existing?: ScheduleRow): Promise<{ fields: Fields } | { error: string }> {
  const has = (k: string) => body[k] !== undefined;
  const name = has("name") ? (typeof body.name === "string" ? body.name.trim() : "") : existing?.name ?? "";
  if (name.length < 1 || name.length > 100) return { error: "Name must be 1 to 100 characters." };
  const frequency = (has("frequency") ? body.frequency : existing?.frequency) as Frequency;
  if (frequency !== "weekly" && frequency !== "monthly") return { error: "Frequency must be weekly or monthly." };
  let weekday: number | null = null;
  let dayOfMonth: number | null = null;
  if (frequency === "weekly") {
    const w = has("weekday") ? body.weekday : existing?.weekday;
    if (typeof w !== "number" || !Number.isInteger(w) || w < 0 || w > 6) return { error: "Weekday must be 0 (Sunday) to 6 (Saturday)." };
    weekday = w;
  } else {
    const d = has("dayOfMonth") ? body.dayOfMonth : existing?.dayOfMonth;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 28) return { error: "Day of month must be 1 to 28." };
    dayOfMonth = d;
  }
  const hour = has("hour") ? body.hour : existing?.hour;
  if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) return { error: "Hour must be 0 to 23." };
  const timezone = has("timezone") ? body.timezone : existing?.timezone ?? "UTC";
  if (!isValidTimeZone(timezone)) return { error: "Unknown time zone." };
  const rangeKey = (has("rangeKey") ? body.rangeKey : existing?.rangeKey ?? "7d") as ScheduleRangeKey;
  if (!["7d", "30d", "90d"].includes(rangeKey)) return { error: "Range must be 7d, 30d or 90d." };
  const platform = has("platform") ? body.platform : existing?.platform ?? null;
  if (platform !== null && !(typeof platform === "string" && (platforms as readonly string[]).includes(platform))) return { error: "Unknown platform." };
  const accountId = has("accountId") ? body.accountId : existing?.accountId ?? null;
  if (accountId !== null) {
    if (typeof accountId !== "string" || !UUID.test(accountId)) return { error: "Unknown account." };
    const [account] = await db.select({ id: connectedAccountsTable.id }).from(connectedAccountsTable).where(and(eq(connectedAccountsTable.id, accountId), eq(connectedAccountsTable.workspaceId, workspaceId)));
    if (!account) return { error: "Unknown account." };
  }
  const enabled = has("enabled") ? body.enabled : existing?.enabled ?? true;
  if (typeof enabled !== "boolean") return { error: "Enabled must be true or false." };
  const recipients = has("recipients") ? parseRecipients(body.recipients) : { ok: true as const, recipients: existing?.recipients ?? [] };
  if (!recipients.ok) return { error: recipients.error };
  if (recipients.recipients.length === 0) return { error: "Add at least one recipient email address." };
  return { fields: { name, frequency, weekday, dayOfMonth, hour, timezone, rangeKey, platform, accountId, recipients: recipients.recipients, enabled } };
}

async function findSchedule(id: string, workspaceId: string): Promise<ScheduleRow | null> {
  if (!UUID.test(id)) return null;
  const result = await db.execute(sql`select * from socialflow_report_schedules where id = ${id} and workspace_id = ${workspaceId}`);
  return result.rows[0] ? mapSchedule(result.rows[0] as Record<string, unknown>) : null;
}

const textArray = (values: string[]) => sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;

router.get("/reports/schedules", async (req, res): Promise<void> => {
  const ctx = await requireReports(req, res, "read");
  if (!ctx) return;
  const result = await db.execute(sql`select * from socialflow_report_schedules where workspace_id = ${ctx.workspaceId} order by created_at asc`);
  res.json({ schedules: (result.rows as Array<Record<string, unknown>>).map(mapSchedule) });
});

router.post("/reports/schedules", async (req, res): Promise<void> => {
  const ctx = await requireReports(req, res, "manage");
  if (!ctx) return;
  const checked = await validate((req.body ?? {}) as Record<string, unknown>, ctx.workspaceId);
  if ("error" in checked) return jsonError(res, 400, "invalid_body", checked.error);
  const f = checked.fields;
  const next = f.enabled ? computeNextRun(f, new Date()) : null;
  const inserted = await db.execute(sql`
    insert into socialflow_report_schedules (workspace_id, created_by, name, frequency, weekday, day_of_month, hour, timezone, range_key, platform, account_id, recipients, enabled, next_run_at)
    values (${ctx.workspaceId}, ${ctx.userId}, ${f.name}, ${f.frequency}, ${f.weekday}, ${f.dayOfMonth}, ${f.hour}, ${f.timezone}, ${f.rangeKey}, ${f.platform}, ${f.accountId}, ${textArray(f.recipients)}, ${f.enabled}, ${next ? next.toISOString() : null}::timestamptz)
    returning *`);
  const schedule = mapSchedule(inserted.rows[0] as Record<string, unknown>);
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "report_schedule.create", target: schedule.id, detail: { name: f.name, recipientCount: f.recipients.length } });
  res.status(201).json(schedule);
});

router.patch("/reports/schedules/:id", async (req, res): Promise<void> => {
  const ctx = await requireReports(req, res, "manage");
  if (!ctx) return;
  const existing = await findSchedule(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Report schedule not found.");
  const checked = await validate((req.body ?? {}) as Record<string, unknown>, ctx.workspaceId, existing);
  if ("error" in checked) return jsonError(res, 400, "invalid_body", checked.error);
  const f = checked.fields;
  const next = f.enabled ? computeNextRun(f, new Date()) : null;
  const updated = await db.execute(sql`
    update socialflow_report_schedules set name = ${f.name}, frequency = ${f.frequency}, weekday = ${f.weekday}, day_of_month = ${f.dayOfMonth}, hour = ${f.hour}, timezone = ${f.timezone},
      range_key = ${f.rangeKey}, platform = ${f.platform}, account_id = ${f.accountId}, recipients = ${textArray(f.recipients)}, enabled = ${f.enabled}, next_run_at = ${next ? next.toISOString() : null}::timestamptz
    where id = ${existing.id} and workspace_id = ${ctx.workspaceId} returning *`);
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "report_schedule.update", target: existing.id });
  res.json(mapSchedule(updated.rows[0] as Record<string, unknown>));
});

router.delete("/reports/schedules/:id", async (req, res): Promise<void> => {
  const ctx = await requireReports(req, res, "manage");
  if (!ctx) return;
  const existing = await findSchedule(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Report schedule not found.");
  await db.execute(sql`delete from socialflow_report_schedules where id = ${existing.id} and workspace_id = ${ctx.workspaceId}`);
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "report_schedule.delete", target: existing.id, detail: { name: existing.name } });
  res.status(204).end();
});

/** Sends the report now without moving the schedule's next run. The outcome, including a failure reason, is the response. */
router.post("/reports/schedules/:id/send-now", sendLimiter, async (req, res): Promise<void> => {
  const ctx = await requireReports(req, res, "manage");
  if (!ctx) return;
  const existing = await findSchedule(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Report schedule not found.");
  const run = await runSchedule(existing);
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "report_schedule.send_now", target: existing.id, detail: { status: run.status } });
  res.json(run);
});

router.get("/reports/schedules/:id/runs", async (req, res): Promise<void> => {
  const ctx = await requireReports(req, res, "read");
  if (!ctx) return;
  const existing = await findSchedule(String(req.params.id), ctx.workspaceId);
  if (!existing) return jsonError(res, 404, "not_found", "Report schedule not found.");
  const result = await db.execute(sql`select * from socialflow_report_runs where schedule_id = ${existing.id} order by ran_at desc limit 50`);
  res.json({ runs: (result.rows as Array<Record<string, unknown>>).map(mapRun) });
});

export default router;

import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { db, reportRunsTable, reportSchedulesTable, workspacesTable } from "@workspace/db";
import { buildReport, resolveRange } from "./analytics-report";
import { logger } from "./logger";
import { mailMode, sendMail } from "./mail";
import type { Platform } from "./oauth/types";
import { rangeDays, renderReportPdf, reportFileName } from "./report-pdf";
import { addDays, isValidTimeZone, zonedParts, zonedToUtc } from "./time";

/*
 * Scheduled analytics reports: a schedule says "every Monday 09:00 in Asia/Kolkata, last 7 days, to these people".
 * The poller claims due schedules (FOR UPDATE SKIP LOCKED, like the publisher), emails the PDF and records the run.
 */

export type Frequency = "weekly" | "monthly";
export type ScheduleRangeKey = "7d" | "30d" | "90d";

export type ScheduleRow = {
  id: string; workspaceId: string; createdBy: string | null; name: string; frequency: Frequency; weekday: number | null; dayOfMonth: number | null; hour: number;
  timezone: string; rangeKey: ScheduleRangeKey; platform: string | null; accountId: string | null; recipients: string[]; enabled: boolean;
  lastRunAt: Date | null; lastStatus: string | null; lastError: string | null; nextRunAt: Date | null; createdAt: Date;
};
export type RunRow = { id: string; scheduleId: string; ranAt: Date; status: "sent" | "failed"; error: string | null; recipientCount: number };

export const MAIL_OFF_MESSAGE = "Email is not set up on this server";
export const MAX_RECIPIENTS = 10;
const EMAIL = /^[^\s@,;<>()"]{1,64}@[^\s@,;<>()"]{1,255}\.[^\s@,;<>()"]{2,}$/;

/** Normalises and validates a recipient list. Returns the cleaned list or an error message. */
export function parseRecipients(value: unknown): { ok: true; recipients: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "Recipients must be a list of email addresses." };
  const cleaned = [...new Set(value.map((v) => (typeof v === "string" ? v.trim().toLowerCase() : "")))];
  if (cleaned.length === 0 || cleaned.some((v) => v === "")) return { ok: false, error: "Add at least one recipient email address." };
  if (cleaned.length > MAX_RECIPIENTS) return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients.` };
  const bad = cleaned.find((v) => v.length > 254 || !EMAIL.test(v));
  if (bad) return { ok: false, error: `"${bad.slice(0, 80)}" is not a valid email address.` };
  return { ok: true, recipients: cleaned };
}

/**
 * The next instant strictly after `after` at which the schedule is due, in its own time zone.
 * Weekly: the given weekday (0 = Sunday) at `hour`. Monthly: the given day of month (1-28) at `hour`.
 */
export function computeNextRun(schedule: { frequency: Frequency; weekday: number | null; dayOfMonth: number | null; hour: number; timezone: string }, after: Date): Date {
  const today = zonedParts(after, schedule.timezone);
  for (let offset = 0; offset <= 62; offset++) {
    const date = addDays(today.year, today.month, today.day, offset);
    const matches = schedule.frequency === "weekly"
      ? new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() === schedule.weekday
      : date.day === schedule.dayOfMonth;
    if (!matches) continue;
    const instant = zonedToUtc(date.year, date.month, date.day, schedule.hour * 60, schedule.timezone);
    if (instant.getTime() > after.getTime()) return instant;
  }
  throw new Error("Could not compute the next report time.");
}

/** Builds the PDF a schedule would send now, or null if the workspace is gone. */
export async function buildSchedulePdf(schedule: ScheduleRow, now = new Date()): Promise<{ pdf: Buffer; fileName: string; workspaceName: string; periodLabel: string } | null> {
  const [workspace] = await db.select({ name: workspacesTable.name }).from(workspacesTable).where(eq(workspacesTable.id, schedule.workspaceId));
  if (!workspace) return null;
  const tz = isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC";
  const range = resolveRange(schedule.rangeKey, tz, {}, now)!;
  const report = await buildReport(schedule.workspaceId, range, { platform: (schedule.platform ?? undefined) as Platform | undefined, accountId: schedule.accountId ?? undefined }, tz, now);
  const days = rangeDays(report.range);
  return { pdf: await renderReportPdf(report, { workspaceName: workspace.name, generatedAt: now }), fileName: reportFileName(report.range), workspaceName: workspace.name, periodLabel: `${days.from} to ${days.to}` };
}

/** Sends one schedule's report and records the run. Never throws; failure is recorded with its reason. */
export async function runSchedule(schedule: ScheduleRow, now = new Date()): Promise<RunRow> {
  let status: "sent" | "failed" = "failed";
  let error: string | null = null;
  let sent = 0;
  try {
    if (mailMode() === "off") {
      error = MAIL_OFF_MESSAGE;
    } else {
      const built = await buildSchedulePdf(schedule, now);
      if (!built) {
        error = "The workspace no longer exists.";
      } else {
        const failures: string[] = [];
        for (const to of schedule.recipients) {
          try {
            await sendMail({
              to, subject: `${schedule.name}: analytics report for ${built.periodLabel}`,
              text: `Your scheduled SocialFlow analytics report for ${built.workspaceName} (${built.periodLabel}) is attached as a PDF.\n\nYou receive this because a report schedule named "${schedule.name}" lists this address.`,
              attachments: [{ filename: built.fileName, content: built.pdf, contentType: "application/pdf" }],
            });
            sent += 1;
          } catch (err) {
            failures.push(`${to}: ${err instanceof Error ? err.message : "send failed"}`);
          }
        }
        if (failures.length === 0) status = "sent";
        else error = `Could not send to ${failures.length} of ${schedule.recipients.length} recipients. ${failures.join("; ")}`.slice(0, 1000);
      }
    }
  } catch (err) {
    error = (err instanceof Error ? err.message : "The report could not be built.").slice(0, 1000);
    logger.error({ err, scheduleId: schedule.id }, "Building a scheduled report failed");
  }
  const [run] = await db.insert(reportRunsTable).values({ scheduleId: schedule.id, ranAt: now, status, error, recipientCount: sent }).returning();
  await db.update(reportSchedulesTable).set({ lastRunAt: now, lastStatus: status, lastError: error }).where(eq(reportSchedulesTable.id, schedule.id));
  return run!;
}

/**
 * Atomically claims schedules whose time has come and moves each one's next_run_at forward in the same transaction, so a
 * schedule runs once per slot even with several instances. A server that was off simply runs a missed schedule once.
 */
export async function claimDueSchedules(limit = 10, now = new Date()): Promise<ScheduleRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(reportSchedulesTable)
      .where(and(eq(reportSchedulesTable.enabled, true), isNotNull(reportSchedulesTable.nextRunAt), lte(reportSchedulesTable.nextRunAt, now)))
      .orderBy(asc(reportSchedulesTable.nextRunAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed: ScheduleRow[] = [];
    for (const schedule of due) {
      const next = computeNextRun(schedule, now);
      await tx.update(reportSchedulesTable).set({ nextRunAt: next }).where(eq(reportSchedulesTable.id, schedule.id));
      claimed.push({ ...schedule, nextRunAt: next });
    }
    return claimed;
  });
}

let cycleRunning = false;

/** One poll: send every due report. Returns how many schedules ran. */
export async function runReportCycle(now = new Date()): Promise<number> {
  if (cycleRunning) return 0;
  cycleRunning = true;
  try {
    const due = await claimDueSchedules(10, now);
    for (const schedule of due) await runSchedule(schedule, now);
    if (due.length) logger.info({ ran: due.length }, "Report cycle finished");
    return due.length;
  } finally {
    cycleRunning = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Starts the report poller (REPORTS_POLL_MINUTES, default 5; REPORTS_DISABLED=true turns it off). */
export function startReports(): void {
  if (timer || process.env.REPORTS_DISABLED === "true") return;
  const minutes = Math.max(1, Number(process.env.REPORTS_POLL_MINUTES) || 5);
  const tick = () => { runReportCycle().catch((error) => logger.error({ err: error }, "Report cycle failed")); };
  timer = setInterval(tick, minutes * 60_000);
  timer.unref();
  tick();
  logger.info({ intervalMinutes: minutes }, "Report scheduler started");
}


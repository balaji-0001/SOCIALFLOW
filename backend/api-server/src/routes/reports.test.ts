import { inflateSync } from "node:zlib";
import cookieParser from "cookie-parser";
import express from "express";
import pinoHttp from "pino-http";
import { logger } from "../lib/logger";
import { inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { accountMetricsTable, db, postMetricsTable, postsTable, postTargetsTable, tableExists, usersTable, workspacesTable } from "@workspace/db";
import { saveConnectedAccount } from "../lib/oauth/accounts";

// Reports: the PDF export, schedule CRUD and permissions, next-run maths, and the scheduler sending through (faked) mail.

type Sent = { to: string; subject: string; text: string; attachments?: Array<{ filename: string; content: Buffer; contentType?: string }> };
vi.hoisted(() => { process.env.REPORTS_SEND_RATE_LIMIT = "1000"; });
const mail = vi.hoisted(() => ({ mode: "smtp" as "smtp" | "off", sent: [] as Array<unknown>, failFor: new Set<string>() }));
vi.mock("../lib/mail", () => ({
  mailMode: () => mail.mode,
  sendMail: async (message: { to: string }) => {
    if (mail.failFor.has(message.to)) throw new Error("mailbox unavailable");
    mail.sent.push(message);
  },
}));

const { default: reportsRouter } = await import("./reports");
const { default: authRouter } = await import("./auth");
const { default: teamRouter } = await import("./team");
const { computeNextRun, parseRecipients, runReportCycle, MAIL_OFF_MESSAGE } = await import("../lib/reports");

const app = express();
app.use(pinoHttp({ logger }));
app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.json());
app.use("/api", authRouter);
app.use("/api", teamRouter);
app.use("/api", reportsRouter);

const tablesExist = await tableExists("socialflow_post_metrics").catch(() => false);
const sentTo = (address: string) => (mail.sent as Sent[]).filter((m) => m.to === address);

describe("next run times", () => {
  const after = new Date("2026-03-15T10:00:00.000Z"); // a Sunday
  it("weekly: next matching weekday and hour in the schedule's zone", () => {
    expect(computeNextRun({ frequency: "weekly", weekday: 1, dayOfMonth: null, hour: 9, timezone: "Asia/Kolkata" }, after).toISOString()).toBe("2026-03-16T03:30:00.000Z");
    expect(computeNextRun({ frequency: "weekly", weekday: 0, dayOfMonth: null, hour: 12, timezone: "UTC" }, after).toISOString()).toBe("2026-03-15T12:00:00.000Z");
    // Today's slot has passed, so it is a week away.
    expect(computeNextRun({ frequency: "weekly", weekday: 0, dayOfMonth: null, hour: 8, timezone: "UTC" }, after).toISOString()).toBe("2026-03-22T08:00:00.000Z");
  });
  it("uses the zone's date, not UTC's", () => {
    // 2026-03-15T20:00Z is already Monday 01:30 in Kolkata, so Monday 09:00 IST is that same morning.
    expect(computeNextRun({ frequency: "weekly", weekday: 1, dayOfMonth: null, hour: 9, timezone: "Asia/Kolkata" }, new Date("2026-03-15T20:00:00.000Z")).toISOString()).toBe("2026-03-16T03:30:00.000Z");
  });
  it("monthly: the given day, rolling into next month; follows daylight saving", () => {
    expect(computeNextRun({ frequency: "monthly", weekday: null, dayOfMonth: 1, hour: 8, timezone: "UTC" }, after).toISOString()).toBe("2026-04-01T08:00:00.000Z");
    expect(computeNextRun({ frequency: "monthly", weekday: null, dayOfMonth: 15, hour: 12, timezone: "UTC" }, after).toISOString()).toBe("2026-03-15T12:00:00.000Z");
    expect(computeNextRun({ frequency: "monthly", weekday: null, dayOfMonth: 28, hour: 9, timezone: "America/New_York" }, new Date("2026-03-30T00:00:00.000Z")).toISOString()).toBe("2026-04-28T13:00:00.000Z");
    expect(computeNextRun({ frequency: "monthly", weekday: null, dayOfMonth: 10, hour: 9, timezone: "America/New_York" }, new Date("2026-03-01T00:00:00.000Z")).toISOString()).toBe("2026-03-10T13:00:00.000Z");
  });
});

describe("recipients", () => {
  it("validates, lowercases and de-duplicates; caps at 10", () => {
    expect(parseRecipients([" A@Example.com ", "a@example.com", "b@x.io"])).toEqual({ ok: true, recipients: ["a@example.com", "b@x.io"] });
    expect(parseRecipients([])).toMatchObject({ ok: false });
    expect(parseRecipients(["nope"])).toMatchObject({ ok: false });
    expect(parseRecipients(["a@b.co, c@d.co"])).toMatchObject({ ok: false });
    expect(parseRecipients(Array.from({ length: 11 }, (_, i) => `u${i}@x.io`))).toMatchObject({ ok: false });
    expect(parseRecipients("a@b.co")).toMatchObject({ ok: false });
  });
});

/** Text drawn on a PDF's pages: inflate each stream and read the hex strings inside TJ operators. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const out: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const bytes = Buffer.from(match[1]!, "latin1");
    let content: string;
    try { content = inflateSync(bytes).toString("latin1"); } catch { content = match[1]!; }
    for (const tj of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      out.push([...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, "hex").toString("latin1")).join(""));
    }
    for (const t of content.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) out.push(Buffer.from(t[1]!, "hex").toString("latin1"));
  }
  return out.join("\n");
}

const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;
const PASSWORD = "correct horse battery staple";

async function signup() {
  const agent = request.agent(app);
  const email = `reports-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: PASSWORD, displayName: "Tester" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, email, workspaceId: res.body.workspace.id as string };
}

async function addMember(owner: Awaited<ReturnType<typeof signup>>, role: string) {
  const member = await signup();
  const invite = await owner.agent.post("/api/team/invitations").send({ email: member.email, role });
  expect(invite.status).toBe(201);
  const token = /token=([A-Za-z0-9_-]+)/.exec(invite.body.inviteUrl)![1]!;
  expect((await member.agent.post(`/api/invitations/${token}/accept`)).status).toBe(200);
  return member;
}

async function facebookPage(workspaceId: string, id: string, name: string) {
  return saveConnectedAccount(db, workspaceId, "facebook", {
    externalAccountId: id, accountType: "facebook_page", displayName: name, username: null, avatarUrl: null, accessToken: `TOKEN_${id}`,
    refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: ["pages_manage_posts"], metadata: {}, selectable: true, warnings: [],
  }, "u");
}

const body = (over: Record<string, unknown> = {}) => ({ name: "Weekly wrap", frequency: "weekly", weekday: 1, hour: 9, timezone: "Asia/Kolkata", rangeKey: "7d", recipients: ["boss@example.com"], ...over });

describe.skipIf(!tablesExist)("Reports (database)", () => {
  beforeEach(() => { mail.mode = "smtp"; mail.sent.length = 0; mail.failFor.clear(); });
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("PDF: real numbers from stored snapshots, honest about unreported metrics", async () => {
    const { agent, workspaceId } = await signup();
    const page = await facebookPage(workspaceId, "9001", "Reports Page");
    const hourAgo = new Date(Date.now() - 3600_000);
    const [post] = await db.insert(postsTable).values({ workspaceId, content: "Launch day announcement", status: "published", scheduledAt: hourAgo, publishedAt: hourAgo }).returning();
    const [target] = await db.insert(postTargetsTable).values({ postId: post!.id, connectedAccountId: page.id, status: "published", externalPostId: "9001_a" }).returning();
    await db.insert(accountMetricsTable).values({ connectedAccountId: page.id, followers: 12345 });
    await db.insert(postMetricsTable).values({ postTargetId: target!.id, likes: 4321, comments: 87, shares: 19 });

    const res = await agent.get("/api/analytics/report.pdf?range=7d&tz=UTC").buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="socialflow-analytics-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.pdf"/);
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    const text = pdfText(pdf);
    expect(text).toContain("12,345");
    expect(text).toContain("4,321");
    expect(text).toContain("Launch day announcement");
    expect(text).toContain("Reports Page");
    expect(text).toMatch(/Not reported by the network: Reach - .*read_insights/);
    expect(text).not.toMatch(/Reach\s*\n?\s*0\b/);

    expect((await agent.get("/api/analytics/report.pdf?range=forever")).status).toBe(400);
    expect((await request(app).get("/api/analytics/report.pdf")).status).toBe(401);
  });

  it("schedule CRUD, validation and next_run_at", async () => {
    const { agent } = await signup();
    const created = await agent.post("/api/reports/schedules").send(body({ recipients: ["Boss@Example.com", "boss@example.com", "outside@partner.io"] }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Weekly wrap", frequency: "weekly", weekday: 1, hour: 9, timezone: "Asia/Kolkata", enabled: true, recipients: ["boss@example.com", "outside@partner.io"], lastStatus: null });
    expect(new Date(created.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(computeNextRun(created.body, new Date(created.body.createdAt)).toISOString()).toBe(new Date(created.body.nextRunAt).toISOString());

    for (const bad of [{ name: "" }, { frequency: "daily" }, { weekday: 9 }, { hour: 24 }, { timezone: "Mars/Base" }, { rangeKey: "1y" }, { recipients: ["nope"] }, { recipients: [] }, { platform: "myspace" }, { accountId: "00000000-0000-4000-8000-000000000000" }]) {
      expect((await agent.post("/api/reports/schedules").send(body(bad))).status).toBe(400);
    }
    expect((await agent.post("/api/reports/schedules").send({ name: "M", frequency: "monthly", hour: 8, recipients: ["a@b.co"] })).status).toBe(400); // needs dayOfMonth
    const monthly = await agent.patch(`/api/reports/schedules/${created.body.id}`).send({ frequency: "monthly", dayOfMonth: 1, hour: 8, timezone: "UTC" });
    expect(monthly.status).toBe(200);
    expect(monthly.body).toMatchObject({ frequency: "monthly", dayOfMonth: 1, weekday: null });
    expect((await agent.patch(`/api/reports/schedules/${created.body.id}`).send({ dayOfMonth: 29 })).status).toBe(400);
    const off = await agent.patch(`/api/reports/schedules/${created.body.id}`).send({ enabled: false });
    expect(off.body).toMatchObject({ enabled: false, nextRunAt: null });

    expect((await agent.get("/api/reports/schedules")).body.schedules).toHaveLength(1);
    expect((await agent.delete(`/api/reports/schedules/${created.body.id}`)).status).toBe(204);
    expect((await agent.get("/api/reports/schedules")).body.schedules).toHaveLength(0);
    expect((await agent.delete(`/api/reports/schedules/${created.body.id}`)).status).toBe(404);
  });

  it("permissions: viewers read, editors manage; workspaces are isolated", async () => {
    const owner = await signup();
    const viewer = await addMember(owner, "viewer");
    const editor = await addMember(owner, "editor");
    const approver = await addMember(owner, "approver");
    const created = await editor.agent.post("/api/reports/schedules").send(body());
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    expect((await viewer.agent.get("/api/reports/schedules")).body.schedules).toHaveLength(1);
    expect((await viewer.agent.get(`/api/reports/schedules/${id}/runs`)).status).toBe(200);
    expect((await approver.agent.get("/api/reports/schedules")).status).toBe(200);
    for (const agent of [viewer.agent, approver.agent]) {
      expect((await agent.post("/api/reports/schedules").send(body())).status).toBe(403);
      expect((await agent.patch(`/api/reports/schedules/${id}`).send({ name: "x" })).status).toBe(403);
      expect((await agent.delete(`/api/reports/schedules/${id}`)).status).toBe(403);
      expect((await agent.post(`/api/reports/schedules/${id}/send-now`)).status).toBe(403);
    }
    expect((await viewer.agent.get("/api/analytics/report.pdf")).status).toBe(200); // analytics:read

    const stranger = await signup();
    expect((await stranger.agent.get("/api/reports/schedules")).body.schedules).toHaveLength(0);
    expect((await stranger.agent.patch(`/api/reports/schedules/${id}`).send({ name: "x" })).status).toBe(404);
    expect((await stranger.agent.delete(`/api/reports/schedules/${id}`)).status).toBe(404);
    expect((await stranger.agent.post(`/api/reports/schedules/${id}/send-now`)).status).toBe(404);
    expect((await stranger.agent.get(`/api/reports/schedules/${id}/runs`)).status).toBe(404);
    const theirPage = await facebookPage(stranger.workspaceId, "9101", "Other Page");
    expect((await owner.agent.post("/api/reports/schedules").send(body({ accountId: theirPage.id }))).status).toBe(400);
    expect((await request(app).get("/api/reports/schedules")).status).toBe(401);
  });

  it("scheduler: sends the PDF through mail, records the run and moves next_run_at on", async () => {
    const { agent } = await signup();
    const created = await agent.post("/api/reports/schedules").send(body({ recipients: ["one@sched.test", "two@sched.test"] }));
    const id = created.body.id as string;
    await db.execute(sql`update socialflow_report_schedules set next_run_at = now(3) - interval 1 minute where id = ${id}`);

    expect(await runReportCycle()).toBeGreaterThanOrEqual(1);
    for (const to of ["one@sched.test", "two@sched.test"]) {
      const [message] = sentTo(to);
      expect(message!.subject).toContain("Weekly wrap");
      expect(message!.attachments![0]).toMatchObject({ contentType: "application/pdf" });
      expect(message!.attachments![0]!.filename).toMatch(/\.pdf$/);
      expect(message!.attachments![0]!.content.subarray(0, 4).toString()).toBe("%PDF");
    }
    const runs = await agent.get(`/api/reports/schedules/${id}/runs`);
    expect(runs.body.runs).toEqual([expect.objectContaining({ status: "sent", error: null, recipientCount: 2 })]);
    const [schedule] = (await agent.get("/api/reports/schedules")).body.schedules;
    expect(schedule).toMatchObject({ lastStatus: "sent", lastError: null });
    expect(new Date(schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    // Not due again until its next slot.
    await runReportCycle();
    expect(sentTo("one@sched.test")).toHaveLength(1);

    // Send now: sends immediately and leaves the schedule's next run alone.
    const sendNow = await agent.post(`/api/reports/schedules/${id}/send-now`);
    expect(sendNow.status).toBe(200);
    expect(sendNow.body).toMatchObject({ status: "sent", recipientCount: 2 });
    expect(sentTo("one@sched.test")).toHaveLength(2);
    expect((await agent.get("/api/reports/schedules")).body.schedules[0].nextRunAt).toBe(schedule.nextRunAt);
    expect((await agent.get(`/api/reports/schedules/${id}/runs`)).body.runs).toHaveLength(2);
  });

  it("failure paths are recorded with a reason, never dropped", async () => {
    const { agent } = await signup();
    const created = await agent.post("/api/reports/schedules").send(body({ recipients: ["ok@fail.test", "bad@fail.test"] }));
    const id = created.body.id as string;

    mail.mode = "off";
    const off = await agent.post(`/api/reports/schedules/${id}/send-now`);
    expect(off.body).toMatchObject({ status: "failed", error: MAIL_OFF_MESSAGE, recipientCount: 0 });
    expect(mail.sent).toHaveLength(0);

    mail.mode = "smtp";
    mail.failFor.add("bad@fail.test");
    const partial = await agent.post(`/api/reports/schedules/${id}/send-now`);
    expect(partial.body.status).toBe("failed");
    expect(partial.body.recipientCount).toBe(1);
    expect(partial.body.error).toContain("bad@fail.test");
    expect(sentTo("ok@fail.test")).toHaveLength(1);

    const [schedule] = (await agent.get("/api/reports/schedules")).body.schedules;
    expect(schedule).toMatchObject({ lastStatus: "failed" });
    expect(schedule.lastError).toContain("bad@fail.test");

    // A due schedule with mail off is also recorded, and moves on rather than retrying every poll.
    mail.mode = "off";
    await db.execute(sql`update socialflow_report_schedules set next_run_at = now(3) - interval 1 minute where id = ${id}`);
    await runReportCycle();
    const runs = (await agent.get(`/api/reports/schedules/${id}/runs`)).body.runs as Array<{ status: string; error: string }>;
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({ status: "failed", error: MAIL_OFF_MESSAGE });
    expect(new Date((await agent.get("/api/reports/schedules")).body.schedules[0].nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });
});

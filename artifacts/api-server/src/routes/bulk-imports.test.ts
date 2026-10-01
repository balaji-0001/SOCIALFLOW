import { asc, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateBulkImportResponse, ListBulkImportsResponse, PreviewBulkImportResponse } from "@workspace/api-zod";
import { auditLogTable, bulkImportsTable, connectedAccountsTable, db, mediaTable, postMediaTable, postTagsTable, postTargetsTable, postsTable, usersTable, workspacesTable } from "@workspace/db";
import { parseCsv, parseScheduledAt } from "../lib/bulk-import";
import { linkPreviewDeps, type HopResponse } from "../lib/link-preview";
import { saveConnectedAccount } from "../lib/oauth/accounts";
import type { Platform } from "../lib/oauth/types";

// CSV bulk import: parsing, the preview's per-row validation, and the import itself (which validates again) creating
// scheduled, queued and draft posts. Image downloads are served by stubs; nothing reaches a real website.

vi.hoisted(() => {
  process.env.BULK_IMPORT_RATE_LIMIT = "1000";
  process.env.BULK_IMPORT_PREVIEW_RATE_LIMIT = "1000";
});
const { default: app } = await import("../app");

const realDeps = { ...linkPreviewDeps };
type Served = { status?: number; type?: string; body?: Buffer };
let handler: (url: URL) => Served = () => ({ status: 404 });
let calls: string[] = [];
beforeEach(() => {
  calls = [];
  handler = () => ({ status: 404 });
  linkPreviewDeps.lookup = async (host) => [{ address: host === "intranet.example" ? "10.0.0.5" : "93.184.216.34", family: 4 }];
  linkPreviewDeps.request = (async (url: URL): Promise<HopResponse> => {
    calls.push(url.toString());
    const { status = 200, type = "image/png", body = Buffer.alloc(0) } = handler(url);
    return { status, headers: { "content-type": type }, body: (async function* () { yield body; })(), destroy: vi.fn() };
  }) as never;
});
afterEach(() => Object.assign(linkPreviewDeps, realDeps));

const png = (width = 600, height = 400) => sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } }).png().toBuffer();

describe("parseCsv", () => {
  it("handles quoted commas, quotes and line breaks, a BOM, CRLF and blank lines", () => {
    const csv = "﻿Content,Scheduled At,ACCOUNTS,extra\r\n\"Hello, world\",2030-01-01 09:00,Acme,x\r\n\r\n\"Line one\nLine two \"\"quoted\"\"\",,\"A; B\",\r\n   ,  ,  ,\r\nlast,,,\r\n";
    const { records, warnings } = parseCsv(csv);
    expect(records).toEqual([
      { row: 2, cells: { content: "Hello, world", scheduled_at: "2030-01-01 09:00", accounts: "Acme" } },
      { row: 4, cells: { content: "Line one\nLine two \"quoted\"", scheduled_at: "", accounts: "A; B" } },
      { row: 6, cells: { content: "last", scheduled_at: "", accounts: "" } },
    ]);
    expect(warnings).toEqual(['The column "extra" isn\'t recognised and was ignored.']);
  });

  it("needs a header with a content column, at least one row, at most 500, and closed quotes", () => {
    expect(() => parseCsv("title,when\na,b")).toThrow(/"content" column/);
    expect(() => parseCsv("content\n")).toThrow(/no rows/);
    expect(() => parseCsv("\n\n")).toThrow(/empty/);
    expect(() => parseCsv(`content\n"never closed`)).toThrow(/quoted field isn't closed/);
    expect(() => parseCsv(`content\n${Array.from({ length: 501 }, (_, i) => `row ${i}`).join("\n")}`)).toThrow(/501 rows; an import can have up to 500/);
    expect(parseCsv(`content\n${Array.from({ length: 500 }, (_, i) => `row ${i}`).join("\n")}`).records).toHaveLength(500);
  });
});

describe("parseScheduledAt", () => {
  it("reads local times in the given zone and ISO dates as written", () => {
    expect(parseScheduledAt("2030-01-15 09:30", "Asia/Kolkata")!.toISOString()).toBe("2030-01-15T04:00:00.000Z");
    expect(parseScheduledAt("2030-07-01T09:30", "America/New_York")!.toISOString()).toBe("2030-07-01T13:30:00.000Z");
    expect(parseScheduledAt("2030-01-15 9:05:30", "UTC")!.toISOString()).toBe("2030-01-15T09:05:30.000Z");
    expect(parseScheduledAt("2030-01-15T09:30:00Z", "Asia/Kolkata")!.toISOString()).toBe("2030-01-15T09:30:00.000Z");
    expect(parseScheduledAt("2030-01-15T09:30:00+05:30", "UTC")!.toISOString()).toBe("2030-01-15T04:00:00.000Z");
    for (const bad of ["tomorrow", "2030-13-01 09:00", "2030-02-30 09:00", "2030-01-15 25:00", "2030-01-15", "15/01/2030 09:00", ""]) expect(parseScheduledAt(bad, "UTC")).toBeNull();
  });
});

const tablesExist = await db.execute(sql`select to_regclass('public.socialflow_bulk_imports') as t`).then((r) => Boolean((r.rows[0] as { t: string | null }).t)).catch(() => false);
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function signup() {
  const agent = request.agent(app);
  const email = `bulk-import-${Date.now()}-${counter++}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple", displayName: "Tester" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, email, workspaceId: res.body.workspace.id as string, userId: res.body.user.id as string };
}

async function account(workspaceId: string, platform: Platform, name: string, username: string | null = null) {
  return saveConnectedAccount(db, workspaceId, platform, {
    externalAccountId: `ext-${counter++}`, accountType: `${platform}_account`, displayName: name, username, avatarUrl: null, accessToken: "TOKEN",
    refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], metadata: {}, selectable: true, warnings: [],
  }, "u");
}

const csvOf = (header: string, ...rows: string[]) => [header, ...rows].join("\n");
type Row = { row: number; content: string; scheduledAt: string | null; accountIds: string[]; accountNames: string[]; link: string | null; firstComment: string | null; tags: string[]; imageUrl: string | null; errors: string[]; warnings: string[] };

describe.skipIf(!tablesExist)("bulk import API (test DB only)", () => {
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  async function workspace() {
    const owner = await signup();
    const fb = await account(owner.workspaceId, "facebook", "Acme Page", "acmepage");
    const li = await account(owner.workspaceId, "linkedin", "Acme Co", "acme-co");
    const ig = await account(owner.workspaceId, "instagram", "Acme Gram", "acme.gram");
    const yt = await account(owner.workspaceId, "youtube", "Acme TV");
    const tag = await owner.agent.post("/api/tags").send({ name: "Launch" });
    expect(tag.status).toBe(201);
    const posts = () => db.select().from(postsTable).where(eq(postsTable.workspaceId, owner.workspaceId)).orderBy(asc(postsTable.scheduledAt), asc(postsTable.createdAt));
    return { ...owner, fb, li, ig, yt, tagId: tag.body.id as string, posts };
  }

  it("preview: validates every row and reports errors and warnings without saving anything", async () => {
    const w = await workspace();
    await db.update(connectedAccountsTable).set({ status: "expired" }).where(eq(connectedAccountsTable.id, w.li.id));
    const csv = csvOf(
      "content,scheduled_at,accounts,link,first_comment,tags,image_url",
      `"Hello, world",2030-01-15 09:30,Acme Page,https://example.com/a,First!,launch,`,                    // 2 valid
      `,2030-01-15 10:00,Acme Page,,,,`,                                                                   // 3 no content
      `Unknown account,2030-01-15 10:00,Nobody Inc,,,,`,                                                   // 4
      `In the past,2020-01-01 10:00,Acme Page,,,,`,                                                        // 5
      `No time,,Acme Page,,,,`,                                                                            // 6
      `Bad time,next tuesday,Acme Page,,,,`,                                                               // 7
      `"Hello, world",2030-01-15 09:30,ACME PAGE,,,,`,                                                     // 8 duplicate of 2
      `By id and handle,2030-01-16 09:00,${w.fb.id} | @acmepage,,,,`,                                      // 9 valid (same account twice)
      `Needs reconnect,2030-01-16 10:00,Acme Co,,,,`,                                                      // 10
      `Insta without image,2030-01-16 11:00,Acme Gram,https://example.com/x,,,`,                           // 11
      `Insta with image,2030-01-16 12:00,acme.gram,,,,https://cdn.example.com/a.png`,                      // 12 valid + warnings
      `Video only,2030-01-16 13:00,Acme TV,,,,`,                                                           // 13
      `Bad extras,2030-01-16 14:00,Acme Page,ftp://example.com,,Nope;Launch,javascript:alert(1)`,          // 14
      `${"x".repeat(2300)},2030-01-16 15:00,Acme Gram,,,,https://cdn.example.com/a.png`,                   // 15 over Instagram's limit
    );
    const res = await w.agent.post("/api/bulk-imports/preview").send({ csv, fileName: "posts.csv", timezone: "Asia/Kolkata", mode: "schedule" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalRows: 14, validCount: 3, errorCount: 11, warnings: [] });
    expect(() => PreviewBulkImportResponse.parse(res.body)).not.toThrow(); // matches the OpenAPI schema
    const rows = new Map<number, Row>((res.body.rows as Row[]).map((row) => [row.row, row]));
    expect(rows.get(2)).toEqual({
      row: 2, content: "Hello, world", scheduledAt: "2030-01-15T04:00:00.000Z", accountIds: [w.fb.id], accountNames: ["Acme Page"],
      link: "https://example.com/a", firstComment: "First!", tags: ["Launch"], imageUrl: null, errors: [], warnings: [],
    });
    expect(rows.get(3)!.errors).toEqual(["Content is empty."]);
    expect(rows.get(4)!.errors).toEqual(['Unknown account "Nobody Inc".']);
    expect(rows.get(5)!.errors).toEqual(["scheduled_at is in the past."]);
    expect(rows.get(6)!.errors[0]).toMatch(/scheduled_at is required when scheduling/);
    expect(rows.get(7)!.errors[0]).toMatch(/"next tuesday" isn't a date and time/);
    expect(rows.get(8)!.errors).toEqual(["Duplicate of row 2."]);
    expect(rows.get(9)).toMatchObject({ accountIds: [w.fb.id], errors: [] });
    expect(rows.get(10)!.errors).toEqual(["Acme Co needs to be reconnected before it can be used."]);
    expect(rows.get(11)!.errors[0]).toMatch(/Instagram posts need an image: add an image_url/);
    expect(rows.get(12)).toMatchObject({ accountNames: ["Acme Gram"], imageUrl: "https://cdn.example.com/a.png", errors: [] });
    expect(rows.get(12)!.warnings.join(" ")).toMatch(/converted to JPG.*downloaded when importing/);
    expect(rows.get(13)!.errors[0]).toMatch(/YouTube posts need a video/);
    expect(rows.get(14)!.errors).toEqual([
      "The link must be a web address starting with http:// or https://.",
      'Unknown tag "Nope". Create it first.',
      "image_url must be a web address starting with http:// or https://.",
    ]);
    expect(rows.get(15)!.errors[0]).toMatch(/over Instagram's 2,200 character limit/);
    // Nothing was fetched or saved.
    expect(calls).toHaveLength(0);
    expect(await w.posts()).toHaveLength(0);
    expect(await db.select().from(bulkImportsTable).where(eq(bulkImportsTable.workspaceId, w.workspaceId))).toHaveLength(0);
  });

  it("preview: default accounts, modes, and whole-file problems", async () => {
    const w = await workspace();
    const stranger = await signup();
    const foreign = await account(stranger.workspaceId, "facebook", "Other Page");

    // Default accounts fill rows that name none; a row's own accounts win.
    const defaults = await w.agent.post("/api/bulk-imports/preview").send({ csv: csvOf("content,accounts", "Uses defaults,", "Own account,Acme Co", "Other workspace's account,Other Page"), mode: "draft", defaultAccountIds: [w.fb.id] });
    expect(defaults.status).toBe(200);
    expect(defaults.body.rows.map((row: Row) => [row.accountNames, row.errors])).toEqual([[["Acme Page"], []], [["Acme Co"], []], [[], ['Unknown account "Other Page".']]]);
    const none = await w.agent.post("/api/bulk-imports/preview").send({ csv: csvOf("content", "No accounts anywhere"), mode: "draft" });
    expect(none.body.rows[0].errors[0]).toMatch(/No accounts/);

    // Queue and draft modes ignore scheduled_at (with a note) and don't require it.
    const queue = await w.agent.post("/api/bulk-imports/preview").send({ csv: csvOf("content,scheduled_at", "A,2020-01-01 09:00", "B,"), mode: "queue", defaultAccountIds: [w.fb.id] });
    expect(queue.body).toMatchObject({ validCount: 2, errorCount: 0 });
    expect(queue.body.rows[0]).toMatchObject({ scheduledAt: null, warnings: [expect.stringMatching(/ignored: queued posts/)] });
    // Without a time, identical rows are duplicates in queue mode.
    const dupes = await w.agent.post("/api/bulk-imports/preview").send({ csv: csvOf("content", "Same", "Same", "Different"), mode: "queue", defaultAccountIds: [w.fb.id] });
    expect(dupes.body.rows.map((row: Row) => row.errors)).toEqual([[], ["Duplicate of row 2."], []]);

    const cases: Array<[Record<string, unknown>, number, RegExp]> = [
      [{ csv: csvOf("content", ...Array.from({ length: 501 }, (_, i) => `Post ${i}`)), mode: "draft" }, 400, /501 rows/],
      [{ csv: csvOf("text_of_post,when", "a,b"), mode: "draft" }, 400, /"content" column/],
      [{ csv: "", mode: "draft" }, 400, /Choose a CSV file/],
      [{ mode: "draft" }, 400, /Choose a CSV file/],
      [{ csv: csvOf("content", "a"), mode: "later" }, 400, /schedule, queue or draft/],
      [{ csv: csvOf("content", "a"), mode: "draft", timezone: "Mars/Olympus" }, 400, /time zone/],
      [{ csv: csvOf("content", "a"), mode: "draft", defaultAccountIds: [foreign.id] }, 400, /default accounts don't exist/],
      [{ csv: csvOf("content", "a"), mode: "draft", defaultAccountIds: ["nope"] }, 400, /Default accounts aren't valid/],
      [{ csv: `content\n${"a".repeat(1_048_600)}`, mode: "draft" }, 413, /up to 1 MB/],
    ];
    for (const [body, status, message] of cases) {
      const res = await w.agent.post("/api/bulk-imports/preview").send(body);
      expect([message.source, res.status]).toEqual([message.source, status]);
      expect(res.body.message).toMatch(message);
    }
    // A full 500-row file is fine.
    const full = await w.agent.post("/api/bulk-imports/preview").send({ csv: csvOf("content", ...Array.from({ length: 500 }, (_, i) => `Post ${i}`)), mode: "draft", defaultAccountIds: [w.fb.id] });
    expect(full.body).toMatchObject({ totalRows: 500, validCount: 500, errorCount: 0 });
  });

  it("import (schedule): validates again on the server, creates the valid rows as scheduled posts and records the import", async () => {
    const w = await workspace();
    const csv = "﻿" + csvOf(
      "Content,Scheduled_At,Accounts,Link,First_Comment,Tags",
      `"Launch day, at last",2030-03-01 09:00,Acme Page;Acme Co,https://example.com/launch,Thanks for reading,Launch`,
      `"Two\nlines",2030-03-02T09:00:00Z,acmepage,,,`,
      `In the past,2020-01-01 09:00,Acme Page,,,`,
      `,2030-03-03 09:00,Acme Page,,,`,
    ).replace(/\n(?=[^"]*(?:"[^"]*"[^"]*)*$)/g, "\r\n");
    const res = await w.agent.post("/api/bulk-imports").send({ csv, fileName: "launch.csv", timezone: "Asia/Kolkata", mode: "schedule" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "partial", totalRows: 4, created: 2, failed: 2, errors: [{ row: 4, message: "scheduled_at is in the past." }, { row: 5, message: "Content is empty." }] });
    expect(res.body.postIds).toHaveLength(2);
    expect(() => CreateBulkImportResponse.parse(res.body)).not.toThrow();

    const posts = await w.posts();
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ content: "Launch day, at last", status: "scheduled", createdByUserId: w.userId, firstComment: "Thanks for reading", linkUrl: "https://example.com/launch", linkTitle: null, linkImageUrl: null });
    expect(posts[0]!.scheduledAt!.toISOString()).toBe("2030-03-01T03:30:00.000Z");
    expect(posts[1]).toMatchObject({ content: "Two\nlines", status: "scheduled", linkUrl: null, firstComment: null });
    expect(posts[1]!.scheduledAt!.toISOString()).toBe("2030-03-02T09:00:00.000Z");
    const targets = await db.select().from(postTargetsTable).where(eq(postTargetsTable.postId, posts[0]!.id));
    expect(targets.map((target) => target.connectedAccountId).sort()).toEqual([w.fb.id, w.li.id].sort());
    expect(targets.every((target) => target.status === "scheduled")).toBe(true);
    expect((await db.select().from(postTagsTable).where(eq(postTagsTable.postId, posts[0]!.id))).map((row) => row.tagId)).toEqual([w.tagId]);
    // The posts are ordinary posts: the API serves them like any other.
    const listed = await w.agent.get("/api/posts");
    expect(listed.body.posts.map((post: { content: string }) => post.content)).toEqual(["Launch day, at last", "Two\nlines"]);
    expect(listed.body.posts[0].tags.map((tag: { name: string }) => tag.name)).toEqual(["Launch"]);

    const history = await w.agent.get("/api/bulk-imports");
    expect(history.status).toBe(200);
    expect(history.body.imports).toHaveLength(1);
    expect(() => ListBulkImportsResponse.parse(history.body)).not.toThrow();
    expect(history.body.imports[0]).toMatchObject({ id: res.body.importId, fileName: "launch.csv", totalRows: 4, createdCount: 2, failedCount: 2, status: "partial", mode: "schedule", errors: res.body.errors });
    const audit = await db.select().from(auditLogTable).where(eq(auditLogTable.workspaceId, w.workspaceId));
    expect(audit.find((entry) => entry.action === "bulk_import.complete")).toMatchObject({ target: res.body.importId, detail: { fileName: "launch.csv", mode: "schedule", created: 2, failed: 2 } });
  });

  it("import (draft and queue): drafts have no time; queued posts take the next free slots one after another", async () => {
    const w = await workspace();
    const drafts = await w.agent.post("/api/bulk-imports").send({ csv: csvOf("content,scheduled_at", "Draft one,2030-01-01 09:00", "Draft two,"), mode: "draft", defaultAccountIds: [w.fb.id] });
    expect(drafts.body).toMatchObject({ status: "completed", created: 2, failed: 0, errors: [] });
    expect((await w.posts()).map((post) => [post.status, post.scheduledAt])).toEqual([["draft", null], ["draft", null]]);

    // No posting schedule yet: every row fails with the reason, nothing is created.
    const noQueue = await w.agent.post("/api/bulk-imports").send({ csv: csvOf("content", "Q1", "Q2"), mode: "queue", defaultAccountIds: [w.fb.id] });
    expect(noQueue.body).toMatchObject({ status: "failed", created: 0, failed: 2 });
    expect(noQueue.body.errors[0].message).toMatch(/no posting schedule yet/);

    const slots = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, time: "09:00" }));
    expect((await w.agent.put(`/api/queues/${w.fb.id}`).send({ timezone: "UTC", slots })).status).toBe(200);
    const existing = await w.agent.post("/api/posts").send({ content: "Already queued", connectedAccountIds: [w.fb.id], queue: true });
    expect(existing.status).toBe(201);
    const queued = await w.agent.post("/api/bulk-imports").send({ csv: csvOf("content", "Q1", "Q2", "Q3"), mode: "queue", defaultAccountIds: [w.fb.id] });
    expect(queued.body).toMatchObject({ status: "completed", created: 3, failed: 0 });
    const scheduled = (await w.posts()).filter((post) => post.status === "scheduled");
    expect(scheduled.map((post) => post.content)).toEqual(["Already queued", "Q1", "Q2", "Q3"]);
    const times = scheduled.map((post) => post.scheduledAt!.getTime());
    expect(new Set(times).size).toBe(4);
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBe(24 * 3600_000);
    expect((await w.agent.get("/api/bulk-imports")).body.imports.map((row: { status: string; mode: string }) => [row.mode, row.status])).toEqual([["queue", "completed"], ["queue", "failed"], ["draft", "completed"]]);
  });

  it("import: images are downloaded and attached; a failed download fails only its row", async () => {
    const w = await workspace();
    const picture = await png();
    handler = (url) => url.pathname === "/ok.png" ? { body: picture }
      : url.pathname === "/page.html" ? { type: "text/html", body: Buffer.from("<html></html>") }
      : url.pathname === "/fake.png" ? { body: Buffer.from("this is not a png at all, just text") } : { status: 404 };
    const csv = csvOf(
      "content,accounts,image_url",
      "With a picture,Acme Page,https://cdn.example.com/ok.png",
      "Missing picture,Acme Page,https://cdn.example.com/gone.png",
      "Instagram picture,Acme Gram,https://cdn.example.com/ok.png",
      "Not a picture,Acme Page,https://cdn.example.com/page.html",
      "Internal picture,Acme Page,https://intranet.example/secret.png",
      "Mislabelled,Acme Page,https://cdn.example.com/fake.png",
      "No picture needed,Acme Co,",
    );
    const res = await w.agent.post("/api/bulk-imports").send({ csv, fileName: "pics.csv", mode: "draft" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "partial", created: 3, failed: 4 });
    expect(res.body.errors.map((error: { row: number }) => error.row)).toEqual([3, 5, 6, 7]);
    expect(res.body.errors[0].message).toMatch(/The image couldn't be downloaded: .*404/);
    expect(res.body.errors[1].message).toMatch(/isn't a JPG, PNG, GIF or WebP image/);
    expect(res.body.errors[2].message).toMatch(/private or internal address/);
    expect(res.body.errors[3].message).toMatch(/isn't a JPG, PNG, GIF or WebP image/);
    expect(calls.some((url) => url.includes("intranet.example"))).toBe(false);

    const posts = await db.select().from(postsTable).where(eq(postsTable.workspaceId, w.workspaceId));
    expect(posts.map((post) => post.content).sort()).toEqual(["Instagram picture", "No picture needed", "With a picture"]);
    const attached = await db
      .select({ content: postsTable.content, mimeType: mediaTable.mimeType, kind: mediaTable.kind, width: mediaTable.width })
      .from(postMediaTable).innerJoin(postsTable, eq(postsTable.id, postMediaTable.postId)).innerJoin(mediaTable, eq(mediaTable.id, postMediaTable.mediaId))
      .where(eq(postsTable.workspaceId, w.workspaceId)).orderBy(asc(postsTable.content));
    // Instagram's copy is converted to the JPG it requires; Facebook keeps the PNG.
    expect(attached).toEqual([
      { content: "Instagram picture", mimeType: "image/jpeg", kind: "image", width: 600 },
      { content: "With a picture", mimeType: "image/png", kind: "image", width: 600 },
    ]);
    // Failed rows leave no stray media behind.
    expect(await db.select().from(mediaTable).where(eq(mediaTable.workspaceId, w.workspaceId))).toHaveLength(2);
    const served = await w.agent.get("/api/posts");
    expect(served.body.posts.find((post: { content: string }) => post.content === "With a picture").media).toHaveLength(1);
  });

  it("import: never trusts the preview; an all-invalid file creates nothing and is recorded as failed", async () => {
    const w = await workspace();
    const csv = csvOf("content,scheduled_at,accounts", "A,2030-01-01 09:00,Acme Page", "B,2030-01-02 09:00,Acme Page");
    const preview = await w.agent.post("/api/bulk-imports/preview").send({ csv, mode: "schedule" });
    expect(preview.body.validCount).toBe(2);
    // The account breaks between preview and import: the import sees it.
    await db.update(connectedAccountsTable).set({ status: "revoked" }).where(eq(connectedAccountsTable.id, w.fb.id));
    const res = await w.agent.post("/api/bulk-imports").send({ csv, mode: "schedule" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "failed", created: 0, failed: 2, postIds: [] });
    expect(res.body.errors.map((error: { message: string }) => error.message)).toEqual(Array(2).fill("Acme Page needs to be reconnected before it can be used."));
    expect(await w.posts()).toHaveLength(0);
    expect((await w.agent.get("/api/bulk-imports")).body.imports[0]).toMatchObject({ fileName: "import.csv", status: "failed", createdCount: 0, failedCount: 2 });
    // Whole-file problems are refused outright and leave no history row.
    expect((await w.agent.post("/api/bulk-imports").send({ csv: csvOf("content", ...Array.from({ length: 501 }, (_, i) => `P${i}`)), mode: "draft", defaultAccountIds: [w.li.id] })).status).toBe(400);
    expect((await w.agent.get("/api/bulk-imports")).body.imports).toHaveLength(1);
  });

  it("import: a large file goes in across several transactions", async () => {
    const w = await workspace();
    const rows = Array.from({ length: 120 }, (_, i) => `Post number ${i}`);
    const res = await w.agent.post("/api/bulk-imports").send({ csv: csvOf("content", ...rows), mode: "draft", defaultAccountIds: [w.fb.id, w.li.id] });
    expect(res.body).toMatchObject({ status: "completed", created: 120, failed: 0 });
    expect(new Set(res.body.postIds).size).toBe(120);
    const count = await db.execute(sql`select count(*)::int as posts, (select count(*)::int from socialflow_post_targets t join socialflow_posts p on p.id = t.post_id where p.workspace_id = ${w.workspaceId}) as targets from socialflow_posts where workspace_id = ${w.workspaceId}`);
    expect(count.rows[0]).toEqual({ posts: 120, targets: 240 });
  });

  it("permissions and isolation: viewers can see history but not import; other workspaces see nothing", async () => {
    const w = await workspace();
    const csv = csvOf("content", "Hello");
    expect((await w.agent.post("/api/bulk-imports").send({ csv, mode: "draft", defaultAccountIds: [w.fb.id] })).status).toBe(201);

    const viewer = await signup();
    const invite = await w.agent.post("/api/team/invitations").send({ email: viewer.email, role: "viewer" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(invite.body.inviteUrl)![1]!;
    expect((await viewer.agent.post(`/api/invitations/${token}/accept`)).status).toBe(200);
    expect((await viewer.agent.get("/api/bulk-imports")).body.imports).toHaveLength(1);
    expect((await viewer.agent.post("/api/bulk-imports/preview").send({ csv, mode: "draft", defaultAccountIds: [w.fb.id] })).status).toBe(403);
    expect((await viewer.agent.post("/api/bulk-imports").send({ csv, mode: "draft", defaultAccountIds: [w.fb.id] })).status).toBe(403);

    const stranger = await signup();
    expect((await stranger.agent.get("/api/bulk-imports")).body.imports).toEqual([]);
    // Another workspace's account can't be targeted by id or by name.
    const theirs = await stranger.agent.post("/api/bulk-imports").send({ csv: csvOf("content,accounts", `By id,${w.fb.id}`, "By name,Acme Page"), mode: "draft" });
    expect(theirs.body).toMatchObject({ created: 0, failed: 2 });
    expect((await stranger.agent.post("/api/bulk-imports").send({ csv, mode: "draft", defaultAccountIds: [w.fb.id] })).status).toBe(400);
    for (const call of [request(app).get("/api/bulk-imports"), request(app).post("/api/bulk-imports").send({ csv, mode: "draft" }), request(app).post("/api/bulk-imports/preview").send({ csv, mode: "draft" })]) expect((await call).status).toBe(401);
  });
});

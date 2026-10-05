import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alphabetical,
  approvalSettingsTable,
  db,
  excluded,
  isUniqueViolation,
  nullsLast,
  postsTable,
  tableExists,
  tagsTable,
  usersTable,
  workspacesTable,
} from "@workspace/db";

// The MySQL layer in backend/db/src/compat.ts stands in for what PostgreSQL did natively (RETURNING, ON CONFLICT,
// row-locking claims). Every other test relies on it, so its promises are checked here on their own.

const tablesExist = await tableExists("socialflow_posts").catch(() => false);
const userIds: string[] = [];
const workspaceIds: string[] = [];

async function workspace(): Promise<{ userId: string; workspaceId: string }> {
  const [user] = await db.insert(usersTable).values({ email: `db-compat-${Date.now()}-${Math.random().toString(36).slice(2)}@socialflow.test`, passwordHash: "not-a-real-hash" }).returning();
  const [space] = await db.insert(workspacesTable).values({ name: "Compat", ownerUserId: user!.id }).returning();
  userIds.push(user!.id);
  workspaceIds.push(space!.id);
  return { userId: user!.id, workspaceId: space!.id };
}

describe.skipIf(!tablesExist)("MySQL compatibility layer (test DB only)", () => {
  let ws: { userId: string; workspaceId: string };
  beforeAll(async () => { ws = await workspace(); });
  afterAll(async () => {
    if (workspaceIds.length) await db.delete(workspacesTable).where(inArray(workspacesTable.id, workspaceIds));
    if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  });

  it("insert().returning() gives the stored row: made id, database defaults, dates as Date", async () => {
    const [post] = await db.insert(postsTable).values({ workspaceId: ws.workspaceId }).returning();
    expect(post!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(post).toMatchObject({ workspaceId: ws.workspaceId, content: "", status: "draft", scheduledAt: null });
    expect(post!.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(post!.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(post!.updatedAt.getTime()).toBe(post!.createdAt.getTime());
  });

  it("several rows come back in the order given, sharing the statement's time; chosen fields only", async () => {
    const rows = await db.insert(postsTable).values(["c", "a", "b"].map((content) => ({ workspaceId: ws.workspaceId, content }))).returning({ id: postsTable.id, content: postsTable.content, createdAt: postsTable.createdAt });
    expect(rows.map((row) => row.content)).toEqual(["c", "a", "b"]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["content", "createdAt", "id"]);
    expect(new Set(rows.map((row) => row.createdAt.getTime())).size).toBe(1);
  });

  it("a write without returning() answers how many rows it touched", async () => {
    const [post] = await db.insert(postsTable).values({ workspaceId: ws.workspaceId, content: "count me" }).returning();
    const result = await db.update(postsTable).set({ content: "counted" }).where(eq(postsTable.id, post!.id));
    expect(result.rowCount).toBe(1);
    expect((await db.delete(postsTable).where(eq(postsTable.id, "00000000-0000-0000-0000-000000000000"))).rowCount).toBe(0);
  });

  it("onConflictDoNothing().returning() returns only the rows it actually inserted", async () => {
    const [first] = await db.insert(tagsTable).values({ workspaceId: ws.workspaceId, name: "Launch" }).returning();
    const rows = await db
      .insert(tagsTable)
      .values([{ workspaceId: ws.workspaceId, name: "Launch", color: "#000000" }, { workspaceId: ws.workspaceId, name: "Fresh" }])
      .onConflictDoNothing({ target: [tagsTable.workspaceId, tagsTable.name] })
      .returning({ id: tagsTable.id, name: tagsTable.name });
    expect(rows.map((row) => row.name)).toEqual(["Fresh"]);
    // The existing row is left exactly as it was.
    const [kept] = await db.select().from(tagsTable).where(eq(tagsTable.id, first!.id));
    expect(kept).toEqual(first);
  });

  it("onConflictDoNothing() leaves updated_at alone on the existing row", async () => {
    const [post] = await db.insert(postsTable).values({ workspaceId: ws.workspaceId, content: "same" }).returning();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await db.insert(postsTable).values({ id: post!.id, workspaceId: ws.workspaceId, content: "other" }).onConflictDoNothing();
    const [after] = await db.select().from(postsTable).where(eq(postsTable.id, post!.id));
    expect(after).toMatchObject({ content: "same", updatedAt: post!.updatedAt });
  });

  it("onConflictDoUpdate().returning() returns the row as it now is, inserted or updated; excluded() is the attempted value", async () => {
    const [inserted] = await db.insert(approvalSettingsTable).values({ workspaceId: ws.workspaceId, required: true, updatedBy: ws.userId })
      .onConflictDoUpdate({ target: approvalSettingsTable.workspaceId, set: { required: excluded(approvalSettingsTable.required) } }).returning();
    expect(inserted).toMatchObject({ workspaceId: ws.workspaceId, required: true, updatedBy: ws.userId });
    const [updated] = await db.insert(approvalSettingsTable).values({ workspaceId: ws.workspaceId, required: false })
      .onConflictDoUpdate({ target: approvalSettingsTable.workspaceId, set: { required: excluded(approvalSettingsTable.required) } }).returning();
    expect(updated).toMatchObject({ workspaceId: ws.workspaceId, required: false, updatedBy: ws.userId });
    expect(await db.select().from(approvalSettingsTable).where(eq(approvalSettingsTable.workspaceId, ws.workspaceId))).toHaveLength(1);
  });

  it("update().returning() gives only the matched rows, as they are after the update", async () => {
    const rows = await db.insert(postsTable).values([{ workspaceId: ws.workspaceId, content: "u1", status: "scheduled", scheduledAt: new Date() }, { workspaceId: ws.workspaceId, content: "u2" }]).returning();
    const changed = await db.update(postsTable).set({ status: "publishing" })
      .where(and(inArray(postsTable.id, rows.map((row) => row.id)), eq(postsTable.status, "scheduled"))).returning();
    expect(changed.map((row) => [row.content, row.status])).toEqual([["u1", "publishing"]]);
    expect(changed[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(rows[0]!.updatedAt.getTime());
    expect(await db.update(postsTable).set({ status: "failed" }).where(eq(postsTable.id, "00000000-0000-0000-0000-000000000000")).returning()).toEqual([]);
  });

  it("a conditional update claims a row exactly once, however many try at the same moment", async () => {
    const [post] = await db.insert(postsTable).values({ workspaceId: ws.workspaceId, content: "claim me", status: "scheduled", scheduledAt: new Date() }).returning();
    const claims = await Promise.all(Array.from({ length: 6 }, () =>
      db.update(postsTable).set({ status: "publishing" }).where(and(eq(postsTable.id, post!.id), eq(postsTable.status, "scheduled"))).returning({ id: postsTable.id })));
    expect(claims.filter((rows) => rows.length === 1)).toHaveLength(1);
  });

  it("delete().returning() gives the removed rows as they were", async () => {
    const rows = await db.insert(postsTable).values([{ workspaceId: ws.workspaceId, content: "d1" }, { workspaceId: ws.workspaceId, content: "d2" }]).returning();
    const removed = await db.delete(postsTable).where(inArray(postsTable.id, rows.map((row) => row.id))).returning({ content: postsTable.content });
    expect(removed.map((row) => row.content).sort()).toEqual(["d1", "d2"]);
    expect(await db.select().from(postsTable).where(inArray(postsTable.id, rows.map((row) => row.id)))).toEqual([]);
  });

  it("transactions commit together or not at all, and returning() works inside them", async () => {
    const id = await db.transaction(async (tx) => {
      const [post] = await tx.insert(postsTable).values({ workspaceId: ws.workspaceId, content: "in tx" }).returning();
      const [changed] = await tx.update(postsTable).set({ content: "in tx, changed" }).where(eq(postsTable.id, post!.id)).returning();
      expect(changed!.content).toBe("in tx, changed");
      return post!.id;
    });
    expect((await db.select().from(postsTable).where(eq(postsTable.id, id)))[0]!.content).toBe("in tx, changed");
    let rolledBack: string | null = null;
    await expect(db.transaction(async (tx) => {
      const [post] = await tx.insert(postsTable).values({ workspaceId: ws.workspaceId, content: "never" }).returning();
      rolledBack = post!.id;
      throw new Error("stop");
    })).rejects.toThrow("stop");
    expect(await db.select().from(postsTable).where(eq(postsTable.id, rolledBack!))).toEqual([]);
  });

  it("execute() answers rows with dates as Date and yes/no columns as boolean, and counts writes", async () => {
    await db.insert(approvalSettingsTable).values({ workspaceId: ws.workspaceId, required: true }).onConflictDoUpdate({ target: approvalSettingsTable.workspaceId, set: { required: true } });
    const result = await db.execute<{ required: boolean; updated_at: Date }>(sql`select required, updated_at from socialflow_approval_settings where workspace_id = ${ws.workspaceId}`);
    expect(result.rows[0]!.required).toBe(true);
    expect(result.rows[0]!.updated_at).toBeInstanceOf(Date);
    const write = await db.execute(sql`update socialflow_approval_settings set required = false where workspace_id = ${ws.workspaceId}`);
    expect(write).toMatchObject({ rows: [], rowCount: 1 });
  });

  it("instants survive the round trip in UTC to the millisecond, including in hand-written SQL", async () => {
    const at = new Date("2026-03-29T01:30:15.123Z");
    const [post] = await db.insert(postsTable).values({ workspaceId: ws.workspaceId, content: "when", status: "scheduled", scheduledAt: at }).returning();
    expect(post!.scheduledAt!.toISOString()).toBe(at.toISOString());
    const found = await db.execute<{ id: string }>(sql`select id from socialflow_posts where id = ${post!.id} and scheduled_at = ${at}`);
    expect(found.rows).toHaveLength(1);
    const [{ utc }] = (await db.execute<{ utc: number }>(sql`select timestampdiff(second, utc_timestamp(), now()) as utc`)).rows as [{ utc: number }];
    expect(utc).toBe(0);
  });

  it("every connection is set up the same way: UTC, READ COMMITTED, strict mode", async () => {
    const settings = await Promise.all(Array.from({ length: 4 }, () => db.execute<{ zone: string; isolation: string; mode: string }>(sql`select @@session.time_zone as zone, @@session.transaction_isolation as isolation, @@session.sql_mode as mode`)));
    for (const { rows } of settings) {
      expect(rows[0]).toMatchObject({ zone: "+00:00", isolation: "READ-COMMITTED" });
      expect(rows[0]!.mode).toContain("STRICT_TRANS_TABLES");
    }
  });

  it("a duplicate is reported as a unique violation", async () => {
    await db.insert(tagsTable).values({ workspaceId: ws.workspaceId, name: "Twice" });
    const error = await db.insert(tagsTable).values({ workspaceId: ws.workspaceId, name: "Twice" }).then(() => null, (caught: unknown) => caught);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error("something else"))).toBe(false);
  });

  it("too long a value is refused, never silently cut short", async () => {
    await expect(db.insert(tagsTable).values({ workspaceId: ws.workspaceId, name: "x".repeat(300) })).rejects.toThrow();
  });

  it("ordering: names alphabetically whatever the case, and empty dates last when ascending", async () => {
    const other = await workspace();
    await db.insert(tagsTable).values(["banana", "Apple", "cherry"].map((name) => ({ workspaceId: other.workspaceId, name })));
    const tags = await db.select({ name: tagsTable.name }).from(tagsTable).where(eq(tagsTable.workspaceId, other.workspaceId)).orderBy(alphabetical(tagsTable.name), asc(tagsTable.name));
    expect(tags.map((tag) => tag.name)).toEqual(["Apple", "banana", "cherry"]);
    await db.insert(postsTable).values([
      { workspaceId: other.workspaceId, content: "draft" },
      { workspaceId: other.workspaceId, content: "later", status: "scheduled", scheduledAt: new Date(Date.now() + 7200_000) },
      { workspaceId: other.workspaceId, content: "sooner", status: "scheduled", scheduledAt: new Date(Date.now() + 3600_000) },
    ]);
    const posts = await db.select({ content: postsTable.content }).from(postsTable).where(eq(postsTable.workspaceId, other.workspaceId)).orderBy(nullsLast(postsTable.scheduledAt), asc(postsTable.scheduledAt));
    expect(posts.map((post) => post.content)).toEqual(["sooner", "later", "draft"]);
  });
});

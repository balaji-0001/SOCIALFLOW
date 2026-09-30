import { and, asc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { customFieldTypes, customFieldsTable, db, mentionGroupsTable, tagsTable, type CustomFieldType } from "@workspace/db";
import { jsonError } from "../lib/http-errors";
import { serializeCustomField } from "../lib/post-extras";
import { requireAccess } from "../lib/access";
import type { WorkspaceContext } from "../lib/session";

/* Tags, custom fields and mention groups: the workspace's post-organisation settings. */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;

async function requireWorkspace(req: Request, res: Response): Promise<WorkspaceContext | null> {
  return requireAccess(req, res, req.method === "GET" ? "posts:read" : "organize:manage");
}

const cleanName = (value: unknown, max = 60): string | null => (typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null);

/* ---------- Tags ---------- */

const serializeTag = (tag: { id: string; name: string; color: string }) => ({ id: tag.id, name: tag.name, color: tag.color });

router.get("/tags", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const rows = await db
    .select({ id: tagsTable.id, name: tagsTable.name, color: tagsTable.color, postCount: sql<number>`(select count(*) from socialflow_post_tags pt where pt.tag_id = ${tagsTable.id})::int` })
    .from(tagsTable)
    .where(eq(tagsTable.workspaceId, ctx.workspaceId))
    .orderBy(asc(tagsTable.name));
  res.json({ tags: rows.map((row) => ({ ...serializeTag(row), postCount: row.postCount })) });
});

router.post("/tags", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const name = cleanName(req.body?.name);
  if (!name) return jsonError(res, 400, "invalid_tag", "Give the tag a name (up to 60 characters).");
  const color = typeof req.body?.color === "string" && COLOR.test(req.body.color) ? req.body.color.toLowerCase() : "#6366f1";
  const [existing] = await db.select({ id: tagsTable.id }).from(tagsTable).where(and(eq(tagsTable.workspaceId, ctx.workspaceId), sql`lower(${tagsTable.name}) = lower(${name})`)).limit(1);
  if (existing) return jsonError(res, 409, "tag_exists", "A tag with that name already exists.");
  const [tag] = await db.insert(tagsTable).values({ workspaceId: ctx.workspaceId, name, color }).returning();
  res.status(201).json({ ...serializeTag(tag!), postCount: 0 });
});

router.patch("/tags/:tagId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.tagId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Tag not found.");
  const changes: { name?: string; color?: string } = {};
  if (req.body?.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return jsonError(res, 400, "invalid_tag", "Give the tag a name (up to 60 characters).");
    const [clash] = await db.select({ id: tagsTable.id }).from(tagsTable).where(and(eq(tagsTable.workspaceId, ctx.workspaceId), sql`lower(${tagsTable.name}) = lower(${name})`, sql`${tagsTable.id} <> ${id}`)).limit(1);
    if (clash) return jsonError(res, 409, "tag_exists", "A tag with that name already exists.");
    changes.name = name;
  }
  if (req.body?.color !== undefined) {
    if (typeof req.body.color !== "string" || !COLOR.test(req.body.color)) return jsonError(res, 400, "invalid_tag", "Pick a colour like #4f46e5.");
    changes.color = req.body.color.toLowerCase();
  }
  const [tag] = await db.update(tagsTable).set(changes).where(and(eq(tagsTable.id, id), eq(tagsTable.workspaceId, ctx.workspaceId))).returning();
  if (!tag) return jsonError(res, 404, "not_found", "Tag not found.");
  res.json(serializeTag(tag));
});

router.delete("/tags/:tagId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.tagId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Tag not found.");
  const deleted = await db.delete(tagsTable).where(and(eq(tagsTable.id, id), eq(tagsTable.workspaceId, ctx.workspaceId))).returning({ id: tagsTable.id });
  if (deleted.length === 0) return jsonError(res, 404, "not_found", "Tag not found.");
  res.sendStatus(204);
});

/* ---------- Custom fields ---------- */

function parseFieldBody(body: Record<string, unknown>, partial: boolean): { ok: true; value: { label?: string; type?: CustomFieldType; options?: string[]; required?: boolean } } | { ok: false; message: string } {
  const value: { label?: string; type?: CustomFieldType; options?: string[]; required?: boolean } = {};
  if (body.label !== undefined || !partial) {
    const label = cleanName(body.label, 80);
    if (!label) return { ok: false, message: "Give the field a label (up to 80 characters)." };
    value.label = label;
  }
  if (body.type !== undefined || !partial) {
    if (!(customFieldTypes as readonly string[]).includes(String(body.type))) return { ok: false, message: "Field type must be text, number, date, select or url." };
    value.type = body.type as CustomFieldType;
  }
  if (body.options !== undefined) {
    if (!Array.isArray(body.options) || body.options.some((option) => typeof option !== "string" || option.trim().length === 0 || option.length > 80)) return { ok: false, message: "Options must be short text values." };
    value.options = [...new Set((body.options as string[]).map((option) => option.trim()))].slice(0, 50);
  }
  if (body.required !== undefined) {
    if (typeof body.required !== "boolean") return { ok: false, message: "required must be true or false." };
    value.required = body.required;
  }
  return { ok: true, value };
}

const keyFromLabel = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";

router.get("/custom-fields", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const rows = await db.select().from(customFieldsTable).where(eq(customFieldsTable.workspaceId, ctx.workspaceId)).orderBy(asc(customFieldsTable.position), asc(customFieldsTable.createdAt));
  res.json({ fields: rows.map(serializeCustomField) });
});

router.post("/custom-fields", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const parsed = parseFieldBody((req.body ?? {}) as Record<string, unknown>, false);
  if (!parsed.ok) return jsonError(res, 400, "invalid_field", parsed.message);
  const { label, type, options = [], required = false } = parsed.value as Required<Pick<typeof parsed.value, "label" | "type">> & typeof parsed.value;
  if (type === "select" && options.length === 0) return jsonError(res, 400, "invalid_field", "A select field needs at least one option.");
  const existing = await db.select({ key: customFieldsTable.key, position: customFieldsTable.position }).from(customFieldsTable).where(eq(customFieldsTable.workspaceId, ctx.workspaceId));
  let key = keyFromLabel(label);
  for (let n = 2; existing.some((row) => row.key === key); n += 1) key = `${keyFromLabel(label)}_${n}`;
  const position = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;
  const [field] = await db.insert(customFieldsTable).values({ workspaceId: ctx.workspaceId, key, label, type, options, required, position }).returning();
  res.status(201).json(serializeCustomField(field!));
});

router.patch("/custom-fields/:fieldId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.fieldId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Field not found.");
  const parsed = parseFieldBody((req.body ?? {}) as Record<string, unknown>, true);
  if (!parsed.ok) return jsonError(res, 400, "invalid_field", parsed.message);
  const changes: Record<string, unknown> = { ...parsed.value };
  if (typeof req.body?.position === "number" && Number.isInteger(req.body.position) && req.body.position >= 0) changes.position = req.body.position;
  const [field] = await db.update(customFieldsTable).set(changes).where(and(eq(customFieldsTable.id, id), eq(customFieldsTable.workspaceId, ctx.workspaceId))).returning();
  if (!field) return jsonError(res, 404, "not_found", "Field not found.");
  res.json(serializeCustomField(field));
});

router.delete("/custom-fields/:fieldId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.fieldId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Field not found.");
  const deleted = await db.delete(customFieldsTable).where(and(eq(customFieldsTable.id, id), eq(customFieldsTable.workspaceId, ctx.workspaceId))).returning({ id: customFieldsTable.id });
  if (deleted.length === 0) return jsonError(res, 404, "not_found", "Field not found.");
  res.sendStatus(204);
});

/* ---------- Mention groups ---------- */

const HANDLE = /^@?[A-Za-z0-9._-]{1,64}$/;

function parseHandles(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  const handles: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const handle = raw.trim();
    if (!HANDLE.test(handle)) return null;
    handles.push(handle.startsWith("@") ? handle : `@${handle}`);
  }
  return [...new Set(handles)];
}

const serializeGroup = (group: { id: string; name: string; handles: string[] }) => ({ id: group.id, name: group.name, handles: group.handles });

router.get("/mention-groups", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const rows = await db.select().from(mentionGroupsTable).where(eq(mentionGroupsTable.workspaceId, ctx.workspaceId)).orderBy(asc(mentionGroupsTable.name));
  res.json({ groups: rows.map(serializeGroup) });
});

router.post("/mention-groups", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const name = cleanName(req.body?.name);
  const handles = parseHandles(req.body?.handles);
  if (!name) return jsonError(res, 400, "invalid_group", "Give the group a name (up to 60 characters).");
  if (!handles) return jsonError(res, 400, "invalid_group", "Add 1 to 50 handles, letters, numbers, dots, dashes or underscores only.");
  const [clash] = await db.select({ id: mentionGroupsTable.id }).from(mentionGroupsTable).where(and(eq(mentionGroupsTable.workspaceId, ctx.workspaceId), sql`lower(${mentionGroupsTable.name}) = lower(${name})`)).limit(1);
  if (clash) return jsonError(res, 409, "group_exists", "A group with that name already exists.");
  const [group] = await db.insert(mentionGroupsTable).values({ workspaceId: ctx.workspaceId, name, handles }).returning();
  res.status(201).json(serializeGroup(group!));
});

router.patch("/mention-groups/:groupId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.groupId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Group not found.");
  const changes: { name?: string; handles?: string[] } = {};
  if (req.body?.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return jsonError(res, 400, "invalid_group", "Give the group a name (up to 60 characters).");
    changes.name = name;
  }
  if (req.body?.handles !== undefined) {
    const handles = parseHandles(req.body.handles);
    if (!handles) return jsonError(res, 400, "invalid_group", "Add 1 to 50 handles, letters, numbers, dots, dashes or underscores only.");
    changes.handles = handles;
  }
  const [group] = await db.update(mentionGroupsTable).set(changes).where(and(eq(mentionGroupsTable.id, id), eq(mentionGroupsTable.workspaceId, ctx.workspaceId))).returning();
  if (!group) return jsonError(res, 404, "not_found", "Group not found.");
  res.json(serializeGroup(group));
});

router.delete("/mention-groups/:groupId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.groupId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Group not found.");
  const deleted = await db.delete(mentionGroupsTable).where(and(eq(mentionGroupsTable.id, id), eq(mentionGroupsTable.workspaceId, ctx.workspaceId))).returning({ id: mentionGroupsTable.id });
  if (deleted.length === 0) return jsonError(res, 404, "not_found", "Group not found.");
  res.sendStatus(204);
});

export default router;

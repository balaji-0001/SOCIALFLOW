import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, isUniqueViolation, mediaTable, type WorkspaceRole } from "@workspace/db";
import { libraryFoldersTable, libraryItemsTable } from "@workspace/db";
import { recordAudit } from "../lib/audit";
import { jsonError } from "../lib/http-errors";
import {
  BODY_MAX, FOLDER_NAME_MAX, PAGE_DEFAULT, PAGE_MAX, SORTS, TITLE_MAX, UUID, decodeCursor, isKind, listItems,
  loadItem, normalizeLabels, placeholdersOf, renderTemplate, serializeItem, type Kind, type Sort,
} from "../lib/library";
import { can, type Permission } from "../lib/permissions";
import { resolveWorkspace, type WorkspaceContext } from "../lib/session";

/* Content library: reusable media references, captions, templates and snippets, in flat folders. */

const router: IRouter = Router();

type LibraryPermission = "library:read" | "library:write";
// Until lib/permissions.ts registers these, fall back to the documented role sets (docs/integration/library.md).
const FALLBACK_ROLES: Record<LibraryPermission, WorkspaceRole[]> = {
  "library:read": ["owner", "admin", "editor", "approver", "viewer"],
  "library:write": ["owner", "admin", "editor"],
};

async function access(req: Request, res: Response, permission: LibraryPermission): Promise<WorkspaceContext | null> {
  const ctx = await resolveWorkspace(req, res);
  if (!ctx) {
    jsonError(res, 401, "unauthorized", "Sign in to continue.");
    return null;
  }
  if (!can(ctx.role, permission as Permission) && !FALLBACK_ROLES[permission].includes(ctx.role)) {
    jsonError(res, 403, "forbidden", "Your role in this workspace doesn't allow that. Ask an owner or admin.");
    return null;
  }
  return ctx;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (res: Response, message: string) => jsonError(res, 400, "invalid_request", message);
const notFound = (res: Response) => jsonError(res, 404, "not_found", "That library item wasn't found.");

function parseTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= TITLE_MAX ? t : null;
}

/** Validates a folder id belongs to the workspace. Returns undefined on success, or sends the error. */
async function folderOk(res: Response, workspaceId: string, folderId: string): Promise<boolean> {
  if (!UUID.test(folderId)) { bad(res, "folderId must be a valid id."); return false; }
  const [row] = await db.select({ id: libraryFoldersTable.id }).from(libraryFoldersTable)
    .where(and(eq(libraryFoldersTable.id, folderId), eq(libraryFoldersTable.workspaceId, workspaceId))).limit(1);
  if (!row) { jsonError(res, 404, "folder_not_found", "That folder wasn't found."); return false; }
  return true;
}

// ---------- folders (registered before /library/:id so "folders" is never read as an id) ----------

const serializeFolder = (row: { id: string; name: string; createdAt: Date }, itemCount: number) => ({ id: row.id, name: row.name, itemCount, createdAt: row.createdAt });

function parseFolderName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= FOLDER_NAME_MAX ? t : null;
}

router.get("/library/folders", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:read");
  if (!ctx) return;
  const rows = await db
    .select({ id: libraryFoldersTable.id, name: libraryFoldersTable.name, createdAt: libraryFoldersTable.createdAt, itemCount: sql<number>`(select count(*) from socialflow_library_items i where i.folder_id = socialflow_library_folders.id)` })
    .from(libraryFoldersTable)
    .where(eq(libraryFoldersTable.workspaceId, ctx.workspaceId))
    .orderBy(sql`lower(${libraryFoldersTable.name})`);
  res.json({ folders: rows.map((r) => serializeFolder(r, r.itemCount)) });
});

router.post("/library/folders", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:write");
  if (!ctx) return;
  const name = parseFolderName(isObject(req.body) ? req.body.name : undefined);
  if (!name) return bad(res, `A folder name of 1 to ${FOLDER_NAME_MAX} characters is required.`);
  try {
    const [row] = await db.insert(libraryFoldersTable).values({ workspaceId: ctx.workspaceId, name }).returning();
    await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "library.folder_created", target: row!.id, detail: { name } });
    res.status(201).json(serializeFolder(row!, 0));
  } catch (error) {
    if (isUniqueViolation(error)) return jsonError(res, 409, "folder_exists", "A folder with that name already exists.");
    throw error;
  }
});

router.patch("/library/folders/:folderId", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:write");
  if (!ctx) return;
  const { folderId } = req.params as { folderId: string };
  if (!UUID.test(folderId)) return jsonError(res, 404, "folder_not_found", "That folder wasn't found.");
  const name = parseFolderName(isObject(req.body) ? req.body.name : undefined);
  if (!name) return bad(res, `A folder name of 1 to ${FOLDER_NAME_MAX} characters is required.`);
  try {
    const [row] = await db.update(libraryFoldersTable).set({ name })
      .where(and(eq(libraryFoldersTable.id, folderId), eq(libraryFoldersTable.workspaceId, ctx.workspaceId))).returning();
    if (!row) return jsonError(res, 404, "folder_not_found", "That folder wasn't found.");
    const [{ n }] = (await db.execute(sql`select count(*) as n from socialflow_library_items where folder_id = ${row.id}`)).rows as Array<{ n: number }>;
    res.json(serializeFolder(row, n!));
  } catch (error) {
    if (isUniqueViolation(error)) return jsonError(res, 409, "folder_exists", "A folder with that name already exists.");
    throw error;
  }
});

/** Deleting a folder keeps its items; they move to "no folder". */
router.delete("/library/folders/:folderId", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:write");
  if (!ctx) return;
  const { folderId } = req.params as { folderId: string };
  if (!UUID.test(folderId)) return jsonError(res, 404, "folder_not_found", "That folder wasn't found.");
  const rows = await db.delete(libraryFoldersTable)
    .where(and(eq(libraryFoldersTable.id, folderId), eq(libraryFoldersTable.workspaceId, ctx.workspaceId))).returning({ id: libraryFoldersTable.id });
  if (rows.length === 0) return jsonError(res, 404, "folder_not_found", "That folder wasn't found.");
  res.status(204).end();
});

// ---------- items ----------

router.get("/library", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:read");
  if (!ctx) return;
  const q = req.query;
  const one = (v: unknown) => (typeof v === "string" ? v : undefined);
  const kind = one(q.kind);
  if (kind !== undefined && !isKind(kind)) return bad(res, "kind must be media, caption, template or snippet.");
  const sort = one(q.sort) ?? "recent";
  if (!(SORTS as readonly string[]).includes(sort)) return bad(res, "sort must be recent, used or name.");
  const folder = one(q.folder);
  if (folder !== undefined && folder !== "none" && !UUID.test(folder)) return bad(res, "folder must be an id or 'none'.");
  const favoriteRaw = one(q.favorite);
  if (favoriteRaw !== undefined && favoriteRaw !== "true" && favoriteRaw !== "false") return bad(res, "favorite must be true or false.");
  let limit = PAGE_DEFAULT;
  if (q.limit !== undefined) {
    const n = Number(one(q.limit));
    if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX) return bad(res, `limit must be between 1 and ${PAGE_MAX}.`);
    limit = n;
  }
  let offset = 0;
  if (q.cursor !== undefined) {
    const decoded = decodeCursor(one(q.cursor) ?? "");
    if (decoded === null) return bad(res, "cursor is not valid.");
    offset = decoded;
  }
  const search = one(q.q)?.trim();
  const result = await listItems(ctx.workspaceId, {
    q: search ? search.slice(0, 200) : undefined,
    kind: kind as Kind | undefined,
    folder,
    favorite: favoriteRaw === undefined ? undefined : favoriteRaw === "true",
    label: one(q.label)?.trim() || undefined,
    sort: sort as Sort,
    limit,
    offset,
  });
  res.json(result);
});

interface Fields { title?: string; body?: string | null; folderId?: string | null; labels?: string[]; favorite?: boolean }

/** Shared validation of the editable fields. `partial` allows omitted keys (PATCH). */
async function parseFields(res: Response, workspaceId: string, body: Record<string, unknown>, partial: boolean): Promise<Fields | null> {
  const out: Fields = {};
  if (!partial || "title" in body) {
    const title = parseTitle(body.title);
    if (!title) { bad(res, `A title of 1 to ${TITLE_MAX} characters is required.`); return null; }
    out.title = title;
  }
  if ("body" in body) {
    if (body.body !== null && typeof body.body !== "string") { bad(res, "body must be text or null."); return null; }
    if (typeof body.body === "string" && body.body.length > BODY_MAX) { bad(res, `body can be at most ${BODY_MAX} characters.`); return null; }
    out.body = body.body as string | null;
  }
  if ("folderId" in body) {
    if (body.folderId !== null) {
      if (typeof body.folderId !== "string" || !(await folderOk(res, workspaceId, body.folderId))) {
        if (typeof body.folderId !== "string") bad(res, "folderId must be an id or null.");
        return null;
      }
    }
    out.folderId = body.folderId as string | null;
  }
  if ("labels" in body) {
    const labels = normalizeLabels(body.labels);
    if ("error" in labels) { bad(res, labels.error); return null; }
    out.labels = labels.labels;
  }
  if ("favorite" in body) {
    if (typeof body.favorite !== "boolean") { bad(res, "favorite must be true or false."); return null; }
    out.favorite = body.favorite;
  }
  return out;
}

router.post("/library", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:write");
  if (!ctx) return;
  if (!isObject(req.body)) return bad(res, "Send a JSON object.");
  const b = req.body;
  if (!isKind(b.kind)) return bad(res, "kind must be media, caption, template or snippet.");
  const fields = await parseFields(res, ctx.workspaceId, b, false);
  if (!fields) return;
  let mediaId: string | null = null;
  if (b.kind === "media") {
    if (typeof b.mediaId !== "string" || !UUID.test(b.mediaId)) return bad(res, "A media item needs the mediaId of an existing upload.");
    const [m] = await db.select({ id: mediaTable.id }).from(mediaTable).where(and(eq(mediaTable.id, b.mediaId), eq(mediaTable.workspaceId, ctx.workspaceId))).limit(1);
    if (!m) return jsonError(res, 404, "media_not_found", "That upload wasn't found.");
    mediaId = m.id;
  } else {
    if (b.mediaId !== undefined && b.mediaId !== null) return bad(res, "Only media items can reference an upload.");
    if (typeof fields.body !== "string" || fields.body.trim() === "") return bad(res, "Text is required for this kind of item.");
  }
  const [row] = await db.insert(libraryItemsTable).values({
    workspaceId: ctx.workspaceId, kind: b.kind, title: fields.title!, body: fields.body ?? null, mediaId,
    folderId: fields.folderId ?? null, labels: fields.labels ?? [], favorite: fields.favorite ?? false, createdBy: ctx.userId,
  }).returning();
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "library.item_created", target: row!.id, detail: { kind: row!.kind } });
  const loaded = await loadItem(ctx.workspaceId, row!.id);
  res.status(201).json(serializeItem(loaded!.item, loaded!.media));
});

/** Save an existing upload to the library. Saving the same upload twice returns the existing item. */
router.post("/library/from-media/:mediaId", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:write");
  if (!ctx) return;
  const { mediaId } = req.params as { mediaId: string };
  if (!UUID.test(mediaId)) return jsonError(res, 404, "media_not_found", "That upload wasn't found.");
  const [m] = await db.select().from(mediaTable).where(and(eq(mediaTable.id, mediaId), eq(mediaTable.workspaceId, ctx.workspaceId))).limit(1);
  if (!m) return jsonError(res, 404, "media_not_found", "That upload wasn't found.");
  const [existing] = await db.select({ id: libraryItemsTable.id }).from(libraryItemsTable)
    .where(and(eq(libraryItemsTable.workspaceId, ctx.workspaceId), eq(libraryItemsTable.mediaId, mediaId))).limit(1);
  if (existing) {
    const loaded = await loadItem(ctx.workspaceId, existing.id);
    res.status(200).json(serializeItem(loaded!.item, loaded!.media));
    return;
  }
  const opts = isObject(req.body) ? req.body : {};
  const fields = await parseFields(res, ctx.workspaceId, { ...opts, title: opts.title ?? m.originalName.slice(0, TITLE_MAX) }, false);
  if (!fields) return;
  const [row] = await db.insert(libraryItemsTable).values({
    workspaceId: ctx.workspaceId, kind: "media", title: fields.title!, body: fields.body ?? null, mediaId: m.id,
    folderId: fields.folderId ?? null, labels: fields.labels ?? [], favorite: fields.favorite ?? false, createdBy: ctx.userId,
  }).returning();
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "library.item_created", target: row!.id, detail: { kind: "media", mediaId } });
  const loaded = await loadItem(ctx.workspaceId, row!.id);
  res.status(201).json(serializeItem(loaded!.item, loaded!.media));
});

router.patch("/library/:id", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:write");
  if (!ctx) return;
  const { id } = req.params as { id: string };
  if (!UUID.test(id)) return notFound(res);
  if (!isObject(req.body)) return bad(res, "Send a JSON object.");
  if ("kind" in req.body || "mediaId" in req.body) return bad(res, "An item's kind and media can't be changed.");
  const current = await loadItem(ctx.workspaceId, id);
  if (!current) return notFound(res);
  const fields = await parseFields(res, ctx.workspaceId, req.body, true);
  if (!fields) return;
  if (current.item.kind !== "media" && "body" in fields && (typeof fields.body !== "string" || fields.body.trim() === "")) return bad(res, "Text is required for this kind of item.");
  if (Object.keys(fields).length === 0) return bad(res, "Nothing to change.");
  await db.update(libraryItemsTable).set({ ...fields, updatedAt: new Date() })
    .where(and(eq(libraryItemsTable.id, id), eq(libraryItemsTable.workspaceId, ctx.workspaceId)));
  const loaded = await loadItem(ctx.workspaceId, id);
  res.json(serializeItem(loaded!.item, loaded!.media));
});

/** Removes the library entry only. The upload it referenced (and any post using it) is never touched. */
router.delete("/library/:id", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:write");
  if (!ctx) return;
  const { id } = req.params as { id: string };
  if (!UUID.test(id)) return notFound(res);
  const rows = await db.delete(libraryItemsTable)
    .where(and(eq(libraryItemsTable.id, id), eq(libraryItemsTable.workspaceId, ctx.workspaceId))).returning({ id: libraryItemsTable.id, kind: libraryItemsTable.kind });
  if (rows.length === 0) return notFound(res);
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "library.item_deleted", target: id, detail: { kind: rows[0]!.kind } });
  res.status(204).end();
});

/** Called by the composer when it inserts the item. Counts the use and returns the item. */
router.post("/library/:id/use", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:write");
  if (!ctx) return;
  const { id } = req.params as { id: string };
  if (!UUID.test(id)) return notFound(res);
  const rows = await db.update(libraryItemsTable)
    .set({ useCount: sql`${libraryItemsTable.useCount} + 1`, lastUsedAt: new Date() })
    .where(and(eq(libraryItemsTable.id, id), eq(libraryItemsTable.workspaceId, ctx.workspaceId))).returning({ id: libraryItemsTable.id });
  if (rows.length === 0) return notFound(res);
  const loaded = await loadItem(ctx.workspaceId, id);
  res.json(serializeItem(loaded!.item, loaded!.media));
});

/** Fills a template's {{placeholders}}. Every placeholder needs a value; nothing is guessed. */
router.post("/library/:id/render", async (req, res): Promise<void> => {
  const ctx = await access(req, res, "library:read");
  if (!ctx) return;
  const { id } = req.params as { id: string };
  if (!UUID.test(id)) return notFound(res);
  const variablesIn = isObject(req.body) && "variables" in req.body ? req.body.variables : {};
  if (!isObject(variablesIn)) return bad(res, "variables must be an object of text values.");
  const variables: Record<string, string> = {};
  for (const [k, v] of Object.entries(variablesIn)) {
    if (typeof v !== "string") return bad(res, `The value for "${k}" must be text.`);
    if (v.length > 2000) return bad(res, `The value for "${k}" is too long (2000 characters at most).`);
    variables[k] = v;
  }
  const loaded = await loadItem(ctx.workspaceId, id);
  if (!loaded) return notFound(res);
  if (loaded.item.kind !== "template" || !loaded.item.body) return bad(res, "Only templates can be rendered.");
  const result = renderTemplate(loaded.item.body, variables);
  if (result.missing.length > 0) {
    res.status(400).json({ error: "missing_variables", message: `Missing values for: ${result.missing.join(", ")}.`, missing: result.missing });
    return;
  }
  if (result.text.length > BODY_MAX * 2) return bad(res, "The rendered text is too long.");
  res.json({ text: result.text, placeholders: placeholdersOf(loaded.item.body) });
});

export default router;

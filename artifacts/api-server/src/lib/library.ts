import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, mediaTable } from "@workspace/db";
import { libraryItemsTable, type LibraryItem } from "@workspace/db";
import { serializeMedia } from "./media";

/* Content library helpers: validation, serialization, template rendering, list query. */

export const TITLE_MAX = 200;
export const BODY_MAX = 20000;
export const LABEL_MAX = 40;
export const LABELS_MAX = 20;
export const FOLDER_NAME_MAX = 80;
export const KINDS = ["media", "caption", "template", "snippet"] as const;
export type Kind = (typeof KINDS)[number];
export const SORTS = ["recent", "used", "name"] as const;
export type Sort = (typeof SORTS)[number];
export const PAGE_DEFAULT = 24;
export const PAGE_MAX = 100;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]{0,49})\s*\}\}/g;

export const isKind = (v: unknown): v is Kind => typeof v === "string" && (KINDS as readonly string[]).includes(v);

/** Distinct placeholder names in order of first appearance. */
export function placeholdersOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Substitutes every placeholder. Never invents values: unresolved names are returned as `missing`. */
export function renderTemplate(text: string, variables: Record<string, string>): { text: string; missing: string[] } {
  const missing = placeholdersOf(text).filter((name) => !Object.prototype.hasOwnProperty.call(variables, name));
  if (missing.length > 0) return { text, missing };
  return { text: text.replace(PLACEHOLDER, (_m, name: string) => variables[name]!), missing: [] };
}

/** Returns a cleaned label list or an error message. */
export function normalizeLabels(input: unknown): { labels: string[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "labels must be an array of strings." };
  const seen = new Map<string, string>();
  for (const raw of input) {
    if (typeof raw !== "string") return { error: "labels must be an array of strings." };
    const label = raw.trim();
    if (!label) continue;
    if (label.length > LABEL_MAX) return { error: `Each label can be at most ${LABEL_MAX} characters.` };
    if (!seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  if (seen.size > LABELS_MAX) return { error: `At most ${LABELS_MAX} labels per item.` };
  return { labels: [...seen.values()] };
}

export function serializeItem(row: LibraryItem, media: typeof mediaTable.$inferSelect | null) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    mediaId: row.mediaId,
    media: media ? serializeMedia(media) : null,
    folderId: row.folderId,
    labels: row.labels,
    favorite: row.favorite,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    placeholders: row.kind === "template" && row.body ? placeholdersOf(row.body) : [],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadItem(workspaceId: string, id: string) {
  const [row] = await db
    .select({ item: libraryItemsTable, media: mediaTable })
    .from(libraryItemsTable)
    .leftJoin(mediaTable, eq(mediaTable.id, libraryItemsTable.mediaId))
    .where(and(eq(libraryItemsTable.id, id), eq(libraryItemsTable.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export type ListFilters = { q?: string; kind?: Kind; folder?: string; favorite?: boolean; label?: string; sort: Sort; limit: number; offset: number };

/** Offset-based opaque cursor; ordering always ends in id so pages are stable. */
export const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString("base64url");
export function decodeCursor(cursor: string): number | null {
  const m = /^o:(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return m ? Number(m[1]) : null;
}

export async function listItems(workspaceId: string, f: ListFilters) {
  const conds: SQL[] = [eq(libraryItemsTable.workspaceId, workspaceId)];
  if (f.q) {
    const pattern = `%${escapeLike(f.q)}%`;
    // Case-insensitive: MySQL's LIKE on these columns is exact, so both sides are lower-cased.
    conds.push(sql`(lower(${libraryItemsTable.title}) like lower(${pattern}) or lower(coalesce(${libraryItemsTable.body}, '')) like lower(${pattern}))`);
  }
  if (f.kind) conds.push(eq(libraryItemsTable.kind, f.kind));
  if (f.folder === "none") conds.push(sql`${libraryItemsTable.folderId} is null`);
  else if (f.folder) conds.push(eq(libraryItemsTable.folderId, f.folder));
  if (f.favorite !== undefined) conds.push(eq(libraryItemsTable.favorite, f.favorite));
  // labels is a JSON list: does its lower-cased form hold the label as one whole entry?
  if (f.label) conds.push(sql`json_contains(lower(${libraryItemsTable.labels}), lower(json_quote(${f.label})))`);
  const order =
    f.sort === "used" ? [desc(libraryItemsTable.useCount), desc(sql`coalesce(${libraryItemsTable.lastUsedAt}, '1970-01-01 00:00:00')`)]
    : f.sort === "name" ? [asc(sql`lower(${libraryItemsTable.title})`)]
    : [desc(libraryItemsTable.createdAt)];
  const rows = await db
    .select({ item: libraryItemsTable, media: mediaTable })
    .from(libraryItemsTable)
    .leftJoin(mediaTable, eq(mediaTable.id, libraryItemsTable.mediaId))
    .where(and(...conds))
    .orderBy(...order, asc(libraryItemsTable.id))
    .limit(f.limit + 1)
    .offset(f.offset);
  const hasMore = rows.length > f.limit;
  return {
    items: rows.slice(0, f.limit).map((r) => serializeItem(r.item, r.media)),
    nextCursor: hasMore ? encodeCursor(f.offset + f.limit) : null,
  };
}

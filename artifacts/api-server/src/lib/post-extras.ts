import { and, asc, eq, inArray } from "drizzle-orm";
import {
  customFieldsTable,
  db,
  postCustomValuesTable,
  postPlatformContentTable,
  postTagsTable,
  tagsTable,
  type CustomField,
  type Tag,
} from "@workspace/db";
import { PLATFORM_CHAR_LIMITS } from "./publisher";
import { platforms, type Platform } from "./oauth/types";

/*
 * The parts of a post that live beside the posts row: per-network text, tags, custom field values and the first
 * comment. Shared by the post routes, the recurrence materializer and the publisher.
 */

export type PlatformContent = Partial<Record<Platform, string>>;
export type CustomValues = Record<string, string>;

export type PostExtras = {
  platformContent: PlatformContent;
  tags: Array<Pick<Tag, "id" | "name" | "color">>;
  customValues: CustomValues;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const MAX_FIRST_COMMENT_LENGTH = 2_000;

/** The text a given network receives: its own version if the user wrote one, otherwise the base text. */
export function effectiveContent(base: string, platformContent: PlatformContent | null | undefined, platform: Platform): string {
  const override = platformContent?.[platform];
  return typeof override === "string" && override.trim().length > 0 ? override : base;
}

export function parsePlatformContent(value: unknown): PlatformContent | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const result: PlatformContent = {};
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (!(platforms as readonly string[]).includes(key)) return null;
    if (typeof text !== "string") return null;
    if (text.trim().length > 0) result[key as Platform] = text;
  }
  return result;
}

/** Why a per-network text can't be used, or null. */
export function platformContentProblem(platformContent: PlatformContent): string | null {
  for (const [platform, text] of Object.entries(platformContent) as Array<[Platform, string]>) {
    if (text.length > PLATFORM_CHAR_LIMITS[platform]) return `The ${platform === "linkedin" ? "LinkedIn" : platform === "youtube" ? "YouTube" : platform[0]!.toUpperCase() + platform.slice(1)} version is over its ${PLATFORM_CHAR_LIMITS[platform].toLocaleString()} character limit.`;
  }
  return null;
}

export async function validateTagIds(workspaceId: string, tagIds: string[]): Promise<string | null> {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return null;
  const found = await db.select({ id: tagsTable.id }).from(tagsTable).where(and(eq(tagsTable.workspaceId, workspaceId), inArray(tagsTable.id, unique)));
  return found.length === unique.length ? null : "One or more tags no longer exist.";
}

const isValidUrl = (value: string) => { try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } };

/**
 * Checks custom field values against the workspace's field definitions. Unknown field IDs and wrong types are
 * refused; `required` fields are only enforced when `strict` (scheduling or publishing), so drafts stay flexible.
 */
export async function validateCustomValues(workspaceId: string, values: CustomValues, strict: boolean): Promise<string | null> {
  const fields = await db.select().from(customFieldsTable).where(eq(customFieldsTable.workspaceId, workspaceId));
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (const [fieldId, raw] of Object.entries(values)) {
    const field = byId.get(fieldId);
    if (!field) return "One of the custom fields no longer exists.";
    if (typeof raw !== "string") return `${field.label} has an invalid value.`;
    const value = raw.trim();
    if (value.length === 0) continue;
    if (value.length > 1_000) return `${field.label} is too long.`;
    if (field.type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) return `${field.label} must be a number.`;
    if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${field.label} must be a date (YYYY-MM-DD).`;
    if (field.type === "url" && !isValidUrl(value)) return `${field.label} must be a link starting with http:// or https://.`;
    if (field.type === "select" && !field.options.includes(value)) return `${field.label} must be one of: ${field.options.join(", ")}.`;
  }
  if (strict) {
    for (const field of fields) {
      if (field.required && !(values[field.id] ?? "").trim()) return `${field.label} is required.`;
    }
  }
  return null;
}

export async function loadExtrasForPosts(postIds: string[]): Promise<Map<string, PostExtras>> {
  const map = new Map<string, PostExtras>();
  if (postIds.length === 0) return map;
  const fresh = (): PostExtras => ({ platformContent: {}, tags: [], customValues: {} });
  for (const id of postIds) map.set(id, fresh());
  const contents = await db.select().from(postPlatformContentTable).where(inArray(postPlatformContentTable.postId, postIds));
  for (const row of contents) map.get(row.postId)!.platformContent[row.platform as Platform] = row.content;
  const tags = await db
    .select({ postId: postTagsTable.postId, id: tagsTable.id, name: tagsTable.name, color: tagsTable.color })
    .from(postTagsTable)
    .innerJoin(tagsTable, eq(tagsTable.id, postTagsTable.tagId))
    .where(inArray(postTagsTable.postId, postIds))
    .orderBy(asc(tagsTable.name));
  for (const row of tags) map.get(row.postId)!.tags.push({ id: row.id, name: row.name, color: row.color });
  const values = await db.select().from(postCustomValuesTable).where(inArray(postCustomValuesTable.postId, postIds));
  for (const row of values) map.get(row.postId)!.customValues[row.fieldId] = row.value;
  return map;
}

export async function loadPlatformContent(postId: string): Promise<PlatformContent> {
  const rows = await db.select().from(postPlatformContentTable).where(eq(postPlatformContentTable.postId, postId));
  const result: PlatformContent = {};
  for (const row of rows) result[row.platform as Platform] = row.content;
  return result;
}

/** Replaces the given extras on a post inside a transaction. Any part left undefined is left alone. */
export async function writePostExtras(tx: Tx, postId: string, extras: { platformContent?: PlatformContent; tagIds?: string[]; customValues?: CustomValues }): Promise<void> {
  if (extras.platformContent) {
    await tx.delete(postPlatformContentTable).where(eq(postPlatformContentTable.postId, postId));
    const rows = Object.entries(extras.platformContent).map(([platform, content]) => ({ postId, platform, content }));
    if (rows.length > 0) await tx.insert(postPlatformContentTable).values(rows);
  }
  if (extras.tagIds) {
    await tx.delete(postTagsTable).where(eq(postTagsTable.postId, postId));
    const unique = [...new Set(extras.tagIds)];
    if (unique.length > 0) await tx.insert(postTagsTable).values(unique.map((tagId) => ({ postId, tagId })));
  }
  if (extras.customValues) {
    await tx.delete(postCustomValuesTable).where(eq(postCustomValuesTable.postId, postId));
    const rows = Object.entries(extras.customValues).filter(([, value]) => value.trim().length > 0).map(([fieldId, value]) => ({ postId, fieldId, value: value.trim() }));
    if (rows.length > 0) await tx.insert(postCustomValuesTable).values(rows);
  }
}

export function serializeCustomField(field: CustomField) {
  return { id: field.id, key: field.key, label: field.label, type: field.type, options: field.options, required: field.required, position: field.position };
}

/*
 * A link attached to a post as a preview card. The title, description and image are a snapshot of what the composer
 * showed (the user may have edited the title and description), stored on the post so what they saw is what goes out.
 */
export type PostLink = { url: string; title: string | null; description: string | null; imageUrl: string | null };

export const MAX_LINK_URL_LENGTH = 2_048;
export const MAX_LINK_TITLE_LENGTH = 300;
export const MAX_LINK_DESCRIPTION_LENGTH = 1_000;

/** undefined = not sent (leave alone); null = remove the link; otherwise the validated link. */
export function parsePostLink(value: unknown): { ok: true; link: PostLink | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, link: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "The link isn't valid." };
  const raw = value as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url || url.length > MAX_LINK_URL_LENGTH || !isValidUrl(url)) return { ok: false, message: "The link must be a web address starting with http:// or https://." };
  const text = (field: unknown, max: number, label: string): { value: string | null } | { message: string } => {
    if (field === undefined || field === null) return { value: null };
    if (typeof field !== "string") return { message: `The link ${label} isn't valid.` };
    const trimmed = field.trim();
    if (trimmed.length > max) return { message: `The link ${label} can be up to ${max.toLocaleString()} characters.` };
    return { value: trimmed || null };
  };
  const title = text(raw.title, MAX_LINK_TITLE_LENGTH, "title");
  if ("message" in title) return { ok: false, message: title.message };
  const description = text(raw.description, MAX_LINK_DESCRIPTION_LENGTH, "description");
  if ("message" in description) return { ok: false, message: description.message };
  let imageUrl: string | null = null;
  if (raw.imageUrl !== undefined && raw.imageUrl !== null && raw.imageUrl !== "") {
    if (typeof raw.imageUrl !== "string" || raw.imageUrl.length > MAX_LINK_URL_LENGTH || !isValidUrl(raw.imageUrl.trim())) return { ok: false, message: "The link image must be a web address starting with http:// or https://." };
    imageUrl = raw.imageUrl.trim();
  }
  return { ok: true, link: { url, title: title.value, description: description.value, imageUrl } };
}

export function linkFromRow(row: { linkUrl: string | null; linkTitle: string | null; linkDescription: string | null; linkImageUrl: string | null }): PostLink | null {
  return row.linkUrl ? { url: row.linkUrl, title: row.linkTitle, description: row.linkDescription, imageUrl: row.linkImageUrl } : null;
}

/** The columns a link is stored in (null clears them). */
export function linkColumns(link: PostLink | null) {
  return { linkUrl: link?.url ?? null, linkTitle: link?.title ?? null, linkDescription: link?.description ?? null, linkImageUrl: link?.imageUrl ?? null };
}

/** An honest note for networks that can't show a link card, or null. Never blocks the post. */
export function linkNoteForPlatform(platform: Platform): string | null {
  if (platform === "instagram") return "Instagram captions can't hold a clickable link. The link stays in the caption as plain text.";
  if (platform === "youtube") return "YouTube posts are videos, so the link can't be shown as a card. It stays in the description as text.";
  return null;
}

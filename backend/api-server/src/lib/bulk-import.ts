import Papa from "papaparse";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { connectedAccountsTable, db, tagsTable } from "@workspace/db";
import { fetchPublicImage, LinkPreviewError, parseHttpUrl } from "./link-preview";
import { instagramJpegFromUrl } from "./link-photo";
import { logger } from "./logger";
import { mediaConfig, pruneUnattachedMedia, saveGeneratedImage, sniffMedia, workspaceUsage } from "./media";
import { mediaProblemForPlatforms, type RuleMedia } from "./media-rules";
import type { Platform } from "./oauth/types";
import { charLimitProblem, insertPost, MAX_CONTENT_LENGTH } from "./post-create";
import { MAX_FIRST_COMMENT_LENGTH, parsePostLink } from "./post-extras";
import { nextFreeSlot } from "./queue";
import { isValidTimeZone, parseDate, zonedToUtc } from "./time";

/*
 * CSV bulk import: up to 500 posts from a spreadsheet. The same validation runs for the preview and again, server
 * side, for the import itself (the preview is never trusted). Valid rows become posts through the composer's own
 * inserts (lib/post-create.ts), 50 per transaction; a row that fails (an image that can't be downloaded, no free
 * queue slot) is reported with its spreadsheet row number and the others still go in.
 */

export const MAX_CSV_BYTES = 1_048_576;
export const MAX_ROWS = 500;
const CHUNK = 50;
const IMAGE_CONCURRENCY = 4;
export const importModes = ["schedule", "queue", "draft"] as const;
export type ImportMode = (typeof importModes)[number];

export class BulkImportError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "BulkImportError";
  }
}

export type ImportRequest = { csv: string; fileName: string; timezone: string; defaultAccountIds: string[]; mode: ImportMode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks the request body shared by preview and import. Throws BulkImportError. */
export function parseImportRequest(body: unknown): ImportRequest {
  const raw = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (typeof raw.csv !== "string" || raw.csv.trim().length === 0) throw new BulkImportError(400, "invalid_body", "Choose a CSV file to import.");
  if (Buffer.byteLength(raw.csv, "utf8") > MAX_CSV_BYTES) throw new BulkImportError(413, "csv_too_large", "The CSV file can be up to 1 MB.");
  const fileName = typeof raw.fileName === "string" && raw.fileName.trim() ? raw.fileName.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) : "import.csv";
  const timezone = raw.timezone === undefined || raw.timezone === null || raw.timezone === "" ? "UTC" : raw.timezone;
  if (!isValidTimeZone(timezone)) throw new BulkImportError(400, "invalid_body", "Unknown time zone.");
  const mode = raw.mode === undefined ? "schedule" : raw.mode;
  if (!importModes.includes(mode as ImportMode)) throw new BulkImportError(400, "invalid_body", "Mode must be schedule, queue or draft.");
  let defaultAccountIds: string[] = [];
  if (raw.defaultAccountIds !== undefined && raw.defaultAccountIds !== null) {
    if (!Array.isArray(raw.defaultAccountIds) || raw.defaultAccountIds.some((id) => typeof id !== "string" || !UUID.test(id))) throw new BulkImportError(400, "invalid_body", "Default accounts aren't valid.");
    defaultAccountIds = [...new Set(raw.defaultAccountIds as string[])];
  }
  return { csv: raw.csv, fileName, timezone, defaultAccountIds, mode: mode as ImportMode };
}

/* ---------- CSV ---------- */

const COLUMN_ALIASES: Record<string, string> = {
  content: "content", text: "content", caption: "content", message: "content", post: "content",
  scheduled_at: "scheduled_at", schedule: "scheduled_at", scheduled: "scheduled_at", publish_at: "scheduled_at", date: "scheduled_at", datetime: "scheduled_at",
  accounts: "accounts", account: "accounts",
  link: "link", url: "link",
  first_comment: "first_comment", comment: "first_comment",
  tags: "tags", tag: "tags",
  image_url: "image_url", image: "image_url", imageurl: "image_url",
};

export type CsvRecord = { row: number; cells: Record<string, string> };

/** Parses RFC 4180 CSV (quoted fields with commas, quotes and line breaks; BOM; CRLF). The first record is the header. */
export function parseCsv(text: string): { records: CsvRecord[]; warnings: string[] } {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { delimiter: ",", skipEmptyLines: false });
  const quoteError = parsed.errors.find((error) => error.type === "Quotes");
  if (quoteError) throw new BulkImportError(400, "invalid_csv", `The CSV couldn't be read: a quoted field isn't closed${typeof quoteError.row === "number" ? ` (around row ${quoteError.row + 1})` : ""}.`);
  const all = parsed.data;
  const headerIndex = all.findIndex((record) => record.some((cell) => cell.trim() !== ""));
  if (headerIndex < 0) throw new BulkImportError(400, "invalid_csv", "The CSV is empty.");
  const columns = new Map<string, number>();
  const warnings: string[] = [];
  all[headerIndex]!.forEach((rawName, index) => {
    const key = rawName.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const column = COLUMN_ALIASES[key];
    if (!column) { if (key) warnings.push(`The column "${rawName.trim().slice(0, 60)}" isn't recognised and was ignored.`); return; }
    if (!columns.has(column)) columns.set(column, index);
  });
  if (!columns.has("content")) throw new BulkImportError(400, "invalid_csv", "The CSV needs a header row with a \"content\" column.");
  const records: CsvRecord[] = [];
  all.forEach((record, index) => {
    if (index <= headerIndex || record.every((cell) => cell.trim() === "")) return;
    const cells: Record<string, string> = {};
    for (const [column, at] of columns) cells[column] = record[at] ?? "";
    records.push({ row: index + 1, cells });
  });
  if (records.length === 0) throw new BulkImportError(400, "invalid_csv", "The CSV has no rows to import.");
  if (records.length > MAX_ROWS) throw new BulkImportError(400, "too_many_rows", `The CSV has ${records.length} rows; an import can have up to ${MAX_ROWS}. Split it into smaller files.`);
  return { records, warnings };
}

/**
 * "2026-03-01 09:30" (or with a T, optional seconds) is read in `timezone`; an ISO date with Z or an offset is taken
 * as written. Returns null when the value isn't one of those.
 */
export function parseScheduledAt(raw: string, timezone: string): Date | null {
  const value = raw.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    const date = parseDate(local[1]);
    const hour = Number(local[2]);
    const minute = Number(local[3]);
    const second = Number(local[4] ?? 0);
    if (!date || hour > 23 || minute > 59 || second > 59) return null;
    return new Date(zonedToUtc(date.year, date.month, date.day, hour * 60 + minute, timezone).getTime() + second * 1000);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    if (!parseDate(value.slice(0, 10))) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/* ---------- validation ---------- */

type Account = { id: string; name: string; username: string | null; platform: Platform; status: string };

export type ValidatedRow = {
  row: number;
  content: string;
  scheduledAt: Date | null;
  accountIds: string[];
  accountNames: string[];
  platforms: Platform[];
  link: string | null;
  firstComment: string | null;
  tags: string[];
  tagIds: string[];
  imageUrl: string | null;
  errors: string[];
  warnings: string[];
};

export type Validation = { rows: ValidatedRow[]; warnings: string[] };

const split = (value: string) => value.split(/[;|]/).map((part) => part.trim()).filter(Boolean);

/** Validates every row against the workspace's accounts and tags. Throws BulkImportError for whole-file problems. */
export async function validateImport(workspaceId: string, request: ImportRequest, now = new Date()): Promise<Validation> {
  const { records, warnings } = parseCsv(request.csv);
  const accountRows = await db
    .select({ id: connectedAccountsTable.id, name: connectedAccountsTable.displayName, username: connectedAccountsTable.username, platform: connectedAccountsTable.platform, status: connectedAccountsTable.status })
    .from(connectedAccountsTable)
    .where(eq(connectedAccountsTable.workspaceId, workspaceId));
  const accounts: Account[] = accountRows.map((row) => ({ ...row, platform: row.platform as Platform }));
  const byId = new Map(accounts.map((account) => [account.id.toLowerCase(), account]));
  if (request.defaultAccountIds.some((id) => !byId.has(id.toLowerCase()))) throw new BulkImportError(400, "invalid_body", "One or more default accounts don't exist in this workspace.");
  const tagRows = await db.select({ id: tagsTable.id, name: tagsTable.name }).from(tagsTable).where(eq(tagsTable.workspaceId, workspaceId));
  const tagsByName = new Map(tagRows.map((tag) => [tag.name.trim().toLowerCase(), tag]));

  const findAccount = (token: string): { account: Account } | { error: string } => {
    const lower = token.toLowerCase();
    const direct = byId.get(lower);
    if (direct) return { account: direct };
    let matches = accounts.filter((account) => account.name.trim().toLowerCase() === lower);
    if (matches.length === 0) {
      const handle = lower.replace(/^@/, "");
      matches = accounts.filter((account) => account.username && account.username.trim().toLowerCase().replace(/^@/, "") === handle);
    }
    if (matches.length === 1) return { account: matches[0]! };
    if (matches.length > 1) return { error: `"${token.slice(0, 80)}" matches more than one account; use the account's ID instead.` };
    return { error: `Unknown account "${token.slice(0, 80)}".` };
  };

  const firstSeen = new Map<string, number>();
  const rows: ValidatedRow[] = records.map(({ row, cells }) => {
    const errors: string[] = [];
    const rowWarnings: string[] = [];
    const content = (cells.content ?? "").trim();
    if (!content) errors.push("Content is empty.");
    else if (content.length > MAX_CONTENT_LENGTH) errors.push(`Content is over ${MAX_CONTENT_LENGTH.toLocaleString()} characters.`);

    // Accounts: the row's own list, or the import's default accounts.
    const chosen: Account[] = [];
    const tokens = split(cells.accounts ?? "");
    if (tokens.length > 0) {
      for (const token of tokens) {
        const found = findAccount(token);
        if ("error" in found) errors.push(found.error);
        else if (!chosen.includes(found.account)) chosen.push(found.account);
      }
    } else {
      for (const id of request.defaultAccountIds) chosen.push(byId.get(id.toLowerCase())!);
    }
    if (chosen.length === 0 && tokens.length === 0) errors.push("No accounts: fill the accounts column or choose default accounts.");
    for (const account of chosen) if (account.status !== "active") errors.push(`${account.name} needs to be reconnected before it can be used.`);
    const platforms = [...new Set(chosen.map((account) => account.platform))];

    if (content) {
      const tooLong = charLimitProblem(content, platforms);
      if (tooLong) errors.push(tooLong);
    }

    // Time.
    let scheduledAt: Date | null = null;
    const rawTime = (cells.scheduled_at ?? "").trim();
    if (request.mode === "schedule") {
      if (!rawTime) errors.push("scheduled_at is required when scheduling (for example 2026-03-01 09:30).");
      else {
        scheduledAt = parseScheduledAt(rawTime, request.timezone);
        if (!scheduledAt) errors.push(`scheduled_at "${rawTime.slice(0, 40)}" isn't a date and time. Use YYYY-MM-DD HH:mm or an ISO date.`);
        else if (scheduledAt.getTime() <= now.getTime()) errors.push("scheduled_at is in the past.");
      }
    } else if (rawTime) {
      rowWarnings.push(request.mode === "queue" ? "scheduled_at is ignored: queued posts take the next free slot." : "scheduled_at is ignored: posts are saved as drafts.");
    }

    // Link.
    let link: string | null = null;
    const rawLink = (cells.link ?? "").trim();
    if (rawLink) {
      const parsed = parsePostLink({ url: rawLink });
      if (!parsed.ok) errors.push(parsed.message);
      else link = parsed.link?.url ?? null;
    }

    // First comment.
    const firstComment = (cells.first_comment ?? "").trim() || null;
    if (firstComment && firstComment.length > MAX_FIRST_COMMENT_LENGTH) errors.push(`first_comment can be up to ${MAX_FIRST_COMMENT_LENGTH.toLocaleString()} characters.`);

    // Tags.
    const tags: string[] = [];
    const tagIds: string[] = [];
    for (const name of split(cells.tags ?? "")) {
      const tag = tagsByName.get(name.toLowerCase());
      if (!tag) errors.push(`Unknown tag "${name.slice(0, 60)}". Create it first.`);
      else if (!tagIds.includes(tag.id)) { tagIds.push(tag.id); tags.push(tag.name); }
    }

    // Image.
    let imageUrl: string | null = null;
    const rawImage = (cells.image_url ?? "").trim();
    if (rawImage) {
      try {
        imageUrl = parseHttpUrl(rawImage).toString();
      } catch {
        errors.push("image_url must be a web address starting with http:// or https://.");
      }
    }

    // What each network needs. A CSV row can carry an image (downloaded on import) but never a video, and its link
    // has no preview picture (no page is fetched), so the link can't stand in for Instagram's photo.
    if (platforms.includes("youtube")) errors.push("YouTube posts need a video, and a CSV import can't attach one. Remove the YouTube account from this row.");
    if (platforms.includes("instagram")) {
      if (!imageUrl && !rawImage) errors.push(link ? "Instagram posts need an image: add an image_url (a link alone has no picture in a CSV import)." : "Instagram posts need an image: add an image_url.");
      else if (imageUrl) rowWarnings.push("Instagram takes JPG only: the image is converted to JPG when importing.");
    }
    if (imageUrl) rowWarnings.push("The image is downloaded when importing; if it can't be, this row fails and the others still import.");

    // The same post twice in one file is almost always a copy-paste slip.
    if (content && chosen.length > 0) {
      const key = JSON.stringify([content, chosen.map((account) => account.id).sort(), request.mode === "schedule" ? scheduledAt?.toISOString() ?? rawTime : ""]);
      const earlier = firstSeen.get(key);
      if (earlier !== undefined) errors.push(`Duplicate of row ${earlier}.`);
      else firstSeen.set(key, row);
    }

    return {
      row, content, scheduledAt, accountIds: chosen.map((account) => account.id), accountNames: chosen.map((account) => account.name), platforms,
      link, firstComment, tags, tagIds, imageUrl, errors, warnings: rowWarnings,
    };
  });
  return { rows, warnings };
}

export function serializePreviewRow(row: ValidatedRow) {
  return {
    row: row.row, content: row.content, scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null, accountIds: row.accountIds, accountNames: row.accountNames,
    link: row.link, firstComment: row.firstComment, tags: row.tags, imageUrl: row.imageUrl, errors: row.errors, warnings: row.warnings,
  };
}

/* ---------- import ---------- */

type Prepared = { row: ValidatedRow; mediaId: string | null };

/** Downloads a row's image, converts it where a network needs that, and stores it as workspace media. */
async function storeRowImage(workspaceId: string, userId: string, row: ValidatedRow, quota: { remaining: number }): Promise<{ ok: true; mediaId: string; media: RuleMedia } | { ok: false; message: string }> {
  const config = mediaConfig();
  try {
    let bytes: Buffer;
    let mimeType: string;
    let ext: string;
    let width: number | null = null;
    let height: number | null = null;
    if (row.platforms.includes("instagram")) {
      const jpeg = await instagramJpegFromUrl(row.imageUrl!);
      ({ bytes, width, height } = jpeg);
      mimeType = "image/jpeg";
      ext = ".jpg";
    } else {
      const fetched = await fetchPublicImage(row.imageUrl!, config.maxImageBytes);
      const sniffed = sniffMedia(fetched.bytes.subarray(0, 16));
      if (!sniffed || sniffed.kind !== "image") return { ok: false, message: "The image_url isn't a JPG, PNG, GIF or WebP image." };
      bytes = fetched.bytes;
      mimeType = sniffed.mime;
      ext = sniffed.ext;
      if (mimeType === "image/webp") {
        // Facebook and LinkedIn don't take WebP; JPG works everywhere.
        bytes = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
        mimeType = "image/jpeg";
        ext = ".jpg";
      }
      try {
        const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch { /* dimensions are only for display */ }
    }
    if (bytes.length > config.maxImageBytes) return { ok: false, message: "The image is larger than the image size limit." };
    if (bytes.length > quota.remaining) return { ok: false, message: "Your media storage is full. Delete unused media and try again." };
    quota.remaining -= bytes.length;
    let name = `import-image${ext}`;
    try { name = `${new URL(row.imageUrl!).hostname.replace(/^www\./, "")}-import${ext}`; } catch { /* keep the default */ }
    const saved = await saveGeneratedImage({ workspaceId, userId, bytes, mimeType, ext, originalName: name, width, height });
    return { ok: true, mediaId: saved.id, media: { kind: "image", mimeType, sizeBytes: bytes.length } };
  } catch (error) {
    const reason = error instanceof LinkPreviewError ? error.message : error instanceof Error && /picture|image/i.test(error.message) ? error.message : "it couldn't be read as an image.";
    return { ok: false, message: `The image couldn't be downloaded: ${reason}` };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export type ImportOutcome = { created: number; failed: number; errors: Array<{ row: number; message: string }>; postIds: string[] };

/** Creates posts for the valid rows. Invalid rows are counted as failed with their validation errors. */
export async function commitImport(workspaceId: string, userId: string, validation: Validation, mode: ImportMode, now = new Date()): Promise<ImportOutcome> {
  const errors: Array<{ row: number; message: string }> = [];
  const postIds: string[] = [];
  for (const row of validation.rows) if (row.errors.length > 0) errors.push({ row: row.row, message: row.errors.join(" ") });
  const valid = validation.rows.filter((row) => row.errors.length === 0);
  const quota = { remaining: Math.max(0, mediaConfig().workspaceQuotaBytes - (await workspaceUsage(workspaceId))) };
  // Queue slots handed out by this import, per account, so rows in the same chunk don't share a slot.
  const queued = new Map<string, Set<number>>();

  for (let start = 0; start < valid.length; start += CHUNK) {
    const chunk = valid.slice(start, start + CHUNK);
    const images = await mapLimit(chunk, IMAGE_CONCURRENCY, (row) => (row.imageUrl ? storeRowImage(workspaceId, userId, row, quota) : Promise.resolve(null)));
    const prepared: Array<Prepared & { status: "draft" | "scheduled"; scheduledAt: Date | null }> = [];
    for (let i = 0; i < chunk.length; i += 1) {
      const row = chunk[i]!;
      const image = images[i];
      if (image && !image.ok) { errors.push({ row: row.row, message: image.message }); continue; }
      const media: RuleMedia[] = image && image.ok ? [image.media] : [];
      const mediaProblem = mediaProblemForPlatforms(row.platforms, media, { hasLinkImage: false });
      const fail = async (message: string) => {
        errors.push({ row: row.row, message });
        if (image && image.ok) await pruneUnattachedMedia(workspaceId, [image.mediaId]);
      };
      if (mediaProblem) { await fail(mediaProblem); continue; }

      let status: "draft" | "scheduled" = "draft";
      let scheduledAt: Date | null = null;
      if (mode === "schedule") {
        if (!row.scheduledAt || row.scheduledAt.getTime() <= Date.now()) { await fail("scheduled_at is in the past."); continue; }
        status = "scheduled";
        scheduledAt = row.scheduledAt;
      } else if (mode === "queue") {
        let after = now;
        let found: Date | null = null;
        let message = "No free queue slot.";
        for (let attempt = 0; attempt < 600 && !found; attempt += 1) {
          const slot = await nextFreeSlot(workspaceId, row.accountIds, after);
          if (!slot.ok) { message = slot.message; break; }
          const instant = slot.slot.at.getTime();
          if (row.accountIds.some((id) => queued.get(id)?.has(instant))) { after = slot.slot.at; continue; }
          found = slot.slot.at;
        }
        if (!found) { await fail(message); continue; }
        for (const id of row.accountIds) {
          if (!queued.has(id)) queued.set(id, new Set());
          queued.get(id)!.add(found.getTime());
        }
        status = "scheduled";
        scheduledAt = found;
      }
      prepared.push({ row, mediaId: image && image.ok ? image.mediaId : null, status, scheduledAt });
    }
    if (prepared.length === 0) continue;
    try {
      const ids = await db.transaction(async (tx) => {
        const created: string[] = [];
        for (const item of prepared) {
          const post = await insertPost(tx, {
            workspaceId, userId, content: item.row.content, accountIds: item.row.accountIds, status: item.status, scheduledAt: item.scheduledAt,
            link: item.row.link ? { url: item.row.link, title: null, description: null, imageUrl: null } : null,
            firstComment: item.row.firstComment, tagIds: item.row.tagIds, mediaIds: item.mediaId ? [item.mediaId] : [],
          });
          created.push(post.id);
        }
        return created;
      });
      postIds.push(...ids);
    } catch (error) {
      logger.error({ err: error, workspaceId }, "Saving a chunk of imported posts failed");
      for (const item of prepared) errors.push({ row: item.row.row, message: "This row couldn't be saved. Try importing it again." });
      await pruneUnattachedMedia(workspaceId, prepared.map((item) => item.mediaId).filter((id): id is string => Boolean(id)));
    }
  }
  errors.sort((a, b) => a.row - b.row);
  return { created: postIds.length, failed: validation.rows.length - postIds.length, errors, postIds };
}


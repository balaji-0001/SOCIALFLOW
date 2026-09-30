import { randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { and, asc, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import { db, mediaTable, postMediaTable, type Media, type MediaKind } from "@workspace/db";
import { signWithAppKey } from "./crypto";
import { logger } from "./logger";
import { recurrenceMediaInUse } from "./recurrence";
import { getRedirectBaseUrl } from "./oauth/config";

/*
 * Media storage.
 *
 * Bytes are streamed to a directory on local disk (MEDIA_STORAGE_DIR, default
 * ./.data/media next to the API server). That is right for development and for
 * a single server with a persistent disk. A serverless or multi-instance
 * deployment needs object storage (S3/R2/GCS) behind these same functions.
 *
 * The file type is decided from the file's own leading bytes, never from the
 * client's filename or Content-Type, so a renamed .exe (or a script named
 * .png) is rejected. SVG is deliberately not accepted: it can carry script.
 */

const MB = 1024 * 1024;

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function mediaConfig() {
  return {
    storageDir: path.resolve(process.env.MEDIA_STORAGE_DIR?.trim() || path.join(process.cwd(), ".data", "media")),
    maxImageBytes: envInt("MEDIA_MAX_IMAGE_BYTES", 10 * MB),
    maxVideoBytes: envInt("MEDIA_MAX_VIDEO_BYTES", 200 * MB),
    maxFilesPerPost: envInt("MEDIA_MAX_FILES_PER_POST", 10),
    workspaceQuotaBytes: envInt("MEDIA_WORKSPACE_QUOTA_BYTES", 2048 * MB),
    orphanMaxAgeMs: envInt("MEDIA_ORPHAN_MAX_AGE_HOURS", 24) * 3600_000,
  };
}

export const ALLOWED_TYPES = [
  { kind: "image", mime: "image/jpeg", ext: ".jpg", label: "JPG" },
  { kind: "image", mime: "image/png", ext: ".png", label: "PNG" },
  { kind: "image", mime: "image/gif", ext: ".gif", label: "GIF" },
  { kind: "image", mime: "image/webp", ext: ".webp", label: "WebP" },
  { kind: "video", mime: "video/mp4", ext: ".mp4", label: "MP4" },
  { kind: "video", mime: "video/quicktime", ext: ".mov", label: "MOV" },
  { kind: "video", mime: "video/webm", ext: ".webm", label: "WebM" },
] as const;

export type Sniffed = { kind: MediaKind; mime: string; ext: string };

const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString("latin1");

/** Identifies the file from its leading bytes. Returns null for anything not on the allow-list. */
export function sniffMedia(head: Buffer): Sniffed | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: ".jpg" };
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mime: "image/png", ext: ".png" };
  if (head.length >= 6 && (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a")) return { kind: "image", mime: "image/gif", ext: ".gif" };
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return { kind: "image", mime: "image/webp", ext: ".webp" };
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp") {
    return ascii(head, 8, 12) === "qt  " ? { kind: "video", mime: "video/quicktime", ext: ".mov" } : { kind: "video", mime: "video/mp4", ext: ".mp4" };
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { kind: "video", mime: "video/webm", ext: ".webm" };
  return null;
}

export type UploadFailure = { status: number; code: string; message: string };
export type UploadResult = { ok: true; media: Media } | { ok: false; failure: UploadFailure };

const fail = (status: number, code: string, message: string): UploadResult => ({ ok: false, failure: { status, code, message } });

const HEAD_BYTES = 16;

function humanSize(bytes: number): string {
  return bytes >= MB ? `${Math.round((bytes / MB) * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The safe part of a client-supplied filename: no path, no control characters, bounded length. */
export function cleanFileName(raw: string | undefined): string {
  let name = raw ?? "";
  try { name = decodeURIComponent(name); } catch { /* keep the raw value */ }
  name = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (name || "upload").slice(0, 200);
}

export type UploadInput = {
  workspaceId: string;
  userId: string;
  fileName: string | undefined;
  declaredLength: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

async function workspaceUsage(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${mediaTable.sizeBytes}), 0)::bigint` })
    .from(mediaTable)
    .where(eq(mediaTable.workspaceId, workspaceId));
  return Number(row?.total ?? 0);
}

/**
 * Streams an upload to disk after validating its real type and size. The
 * partial file is removed on any failure, including the client disconnecting.
 */
export async function saveUpload(source: Readable, input: UploadInput): Promise<UploadResult> {
  const config = mediaConfig();
  const largest = Math.max(config.maxImageBytes, config.maxVideoBytes);
  if (input.declaredLength !== null && input.declaredLength > largest) {
    return fail(413, "file_too_large", `That file is too large. Images can be up to ${humanSize(config.maxImageBytes)} and videos up to ${humanSize(config.maxVideoBytes)}.`);
  }

  const used = await workspaceUsage(input.workspaceId);
  const remaining = config.workspaceQuotaBytes - used;
  if (remaining <= 0 || (input.declaredLength !== null && input.declaredLength > remaining)) {
    return fail(413, "quota_exceeded", "Your media storage is full. Delete unused media and try again.");
  }

  const key = `${input.workspaceId}/${randomUUID()}`;
  let filePath: string | null = null;
  let stream: ReturnType<typeof createWriteStream> | null = null;
  let sniffed: Sniffed | null = null;
  let limit = largest;
  let size = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  const write = (chunk: Buffer) => new Promise<void>((resolve, reject) => {
    stream!.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
  const cleanup = async () => {
    if (stream) stream.destroy();
    if (filePath) await rm(filePath, { force: true }).catch(() => {});
  };

  try {
    // destroyOnReturn: false so that rejecting a file early doesn't tear down the socket before the client can read our answer.
    for await (const raw of source.iterator({ destroyOnReturn: false })) {
      const chunk = raw as Buffer;
      if (!sniffed) {
        pending.push(chunk);
        pendingBytes += chunk.length;
        if (pendingBytes < HEAD_BYTES) continue;
        const head = Buffer.concat(pending);
        sniffed = sniffMedia(head);
        if (!sniffed) return fail(415, "unsupported_type", "That file type isn't supported. Use JPG, PNG, GIF, WebP, MP4, MOV or WebM.");
        limit = sniffed.kind === "image" ? config.maxImageBytes : config.maxVideoBytes;
        if (input.declaredLength !== null && input.declaredLength > limit) {
          return fail(413, "file_too_large", `${sniffed.kind === "image" ? "Images" : "Videos"} can be up to ${humanSize(limit)}.`);
        }
        await mkdir(path.join(config.storageDir, input.workspaceId), { recursive: true });
        filePath = path.join(config.storageDir, `${key}${sniffed.ext}`);
        stream = createWriteStream(filePath, { flags: "wx" });
        size = head.length;
        pending = [];
        await write(head);
        if (size > limit) { await cleanup(); return fail(413, "file_too_large", `${sniffed.kind === "image" ? "Images" : "Videos"} can be up to ${humanSize(limit)}.`); }
        if (size > remaining) { await cleanup(); return fail(413, "quota_exceeded", "Your media storage is full. Delete unused media and try again."); }
        continue;
      }
      size += chunk.length;
      if (size > limit) {
        await cleanup();
        return fail(413, "file_too_large", `${sniffed.kind === "image" ? "Images" : "Videos"} can be up to ${humanSize(limit)}.`);
      }
      if (size > remaining) {
        await cleanup();
        return fail(413, "quota_exceeded", "Your media storage is full. Delete unused media and try again.");
      }
      await write(chunk);
    }

    if (!sniffed || !stream || !filePath) {
      // Fewer than HEAD_BYTES arrived: an empty or truncated file.
      return fail(400, "empty_file", size === 0 && pendingBytes === 0 ? "That file is empty." : "That file is too small to be a valid image or video.");
    }
    await new Promise<void>((resolve, reject) => { stream!.end((error?: Error | null) => (error ? reject(error) : resolve())); });

    try {
      const [row] = await db
        .insert(mediaTable)
        .values({
          workspaceId: input.workspaceId,
          uploadedByUserId: input.userId,
          kind: sniffed.kind,
          mimeType: sniffed.mime,
          originalName: cleanFileName(input.fileName),
          sizeBytes: size,
          storageKey: `${key}${sniffed.ext}`,
          width: input.width,
          height: input.height,
          durationMs: sniffed.kind === "video" ? input.durationMs : null,
        })
        .returning();
      return { ok: true, media: row! };
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    await cleanup();
    logger.warn({ errorName: error instanceof Error ? error.name : typeof error }, "Media upload aborted");
    return fail(400, "upload_aborted", "The upload was interrupted. Please try again.");
  }
}

/**
 * Stores an image the server produced itself (already validated and sized by the caller) as a normal media row,
 * so it can be served through the same signed public URL as a user's upload. Not attached to any post; the orphan
 * sweeper removes it once it has gone unused for a day.
 */
export async function saveGeneratedImage(input: { workspaceId: string; userId: string | null; bytes: Buffer; mimeType: string; ext: string; originalName: string; width: number | null; height: number | null }): Promise<Media> {
  const config = mediaConfig();
  const key = `${input.workspaceId}/${randomUUID()}${input.ext}`;
  await mkdir(path.join(config.storageDir, input.workspaceId), { recursive: true });
  const filePath = path.join(config.storageDir, key);
  await writeFile(filePath, input.bytes, { flag: "wx" });
  try {
    const [row] = await db
      .insert(mediaTable)
      .values({
        workspaceId: input.workspaceId,
        uploadedByUserId: input.userId,
        kind: "image",
        mimeType: input.mimeType,
        originalName: cleanFileName(input.originalName),
        sizeBytes: input.bytes.length,
        storageKey: key,
        width: input.width,
        height: input.height,
        durationMs: null,
      })
      .returning();
    return row!;
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * After rejecting an upload early, read and discard the rest of the request (up to a cap) so the browser can
 * receive the error response. Without this the connection is reset mid-upload and the user sees a generic
 * network failure instead of "Videos can be up to 200 MB". Past the cap we give up and let the socket close.
 */
export async function discardRemainingBody(source: Readable, capBytes = 64 * MB): Promise<void> {
  let discarded = 0;
  try {
    for await (const chunk of source.iterator({ destroyOnReturn: false })) {
      discarded += (chunk as Buffer).length;
      if (discarded > capBytes) return;
    }
  } catch { /* the client went away; nothing left to read */ }
}

/** Absolute path of a stored file, refusing anything that resolves outside the storage directory. */
export function storedFilePath(storageKey: string): string | null {
  const root = mediaConfig().storageDir;
  const resolved = path.resolve(root, storageKey);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

async function removeFiles(keys: string[]): Promise<void> {
  for (const key of keys) {
    const file = storedFilePath(key);
    if (file) await rm(file, { force: true }).catch(() => {});
  }
}

/**
 * A time-limited public link to a file, for networks that fetch media from a URL themselves (Instagram).
 * The signature covers the file ID and expiry, so the link grants that one file until it expires and nothing else.
 * Returns null when the app has no public https address to build it from.
 */
export function signedPublicMediaUrl(mediaId: string, ttlMs = 2 * 3600_000, now = Date.now()): string | null {
  const base = getRedirectBaseUrl();
  if (!base || !base.startsWith("https://")) return null;
  const expires = Math.floor((now + ttlMs) / 1000);
  return `${base}/api/media/public/${mediaId}?e=${expires}&s=${signWithAppKey(`${mediaId}.${expires}`)}`;
}

export function verifyPublicMediaSignature(mediaId: string, expires: unknown, signature: unknown, now = Date.now()): boolean {
  if (typeof expires !== "string" || typeof signature !== "string" || !/^[0-9]{1,12}$/.test(expires)) return false;
  if (Number(expires) * 1000 < now) return false;
  const expected = Buffer.from(signWithAppKey(`${mediaId}.${expires}`));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function serializeMedia(row: Media) {
  return {
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    fileName: row.originalName,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    url: `/api/media/${row.id}/file`,
  };
}

/** The media on each post, in the order the user arranged them. */
export async function loadMediaForPosts(postIds: string[]): Promise<Map<string, Media[]>> {
  const map = new Map<string, Media[]>();
  if (postIds.length === 0) return map;
  const rows = await db
    .select({ postId: postMediaTable.postId, media: mediaTable })
    .from(postMediaTable)
    .innerJoin(mediaTable, eq(mediaTable.id, postMediaTable.mediaId))
    .where(inArray(postMediaTable.postId, postIds))
    .orderBy(asc(postMediaTable.position));
  for (const row of rows) map.set(row.postId, [...(map.get(row.postId) ?? []), row.media]);
  return map;
}

/**
 * Checks a list of media IDs a post wants to carry: within the per-post
 * limit, all in this workspace, and none already used by a different post.
 */
export async function validateMediaIds(workspaceId: string, ids: string[], postId?: string): Promise<string | null> {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) return "The same file was added twice.";
  const { maxFilesPerPost } = mediaConfig();
  if (unique.length > maxFilesPerPost) return `A post can have up to ${maxFilesPerPost} files.`;
  if (unique.length === 0) return null;
  const found = await db.select({ id: mediaTable.id }).from(mediaTable).where(and(eq(mediaTable.workspaceId, workspaceId), inArray(mediaTable.id, unique)));
  if (found.length !== unique.length) return "One or more files couldn't be found. Upload them again.";
  const taken = await db
    .select({ mediaId: postMediaTable.mediaId })
    .from(postMediaTable)
    .where(and(
      inArray(postMediaTable.mediaId, unique),
      postId ? sql`${postMediaTable.postId} <> ${postId}` : sql`true`,
      // Media saved in the content library is shared on purpose: it may be attached to any number of posts.
      sql`not exists (select 1 from socialflow_library_items li where li.media_id = ${postMediaTable.mediaId})`,
    ))
    .limit(1);
  if (taken.length > 0) return "One of those files is already attached to another post.";
  return null;
}

/** Deletes media rows (and their files) from this list that no post uses any more. */
export async function pruneUnattachedMedia(workspaceId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .delete(mediaTable)
    .where(
      and(
        eq(mediaTable.workspaceId, workspaceId),
        inArray(mediaTable.id, ids),
        notExists(db.select({ one: sql`1` }).from(postMediaTable).where(eq(postMediaTable.mediaId, mediaTable.id))),
        sql`not ${recurrenceMediaInUse}`,
        sql`not exists (select 1 from socialflow_library_items li where li.media_id = ${mediaTable.id})`,
      ),
    )
    .returning({ key: mediaTable.storageKey });
  await removeFiles(rows.map((row) => row.key));
  return rows.length;
}

/** Removes uploads that were never attached to a post (abandoned composers, closed tabs). */
export async function sweepOrphanMedia(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - mediaConfig().orphanMaxAgeMs);
  const rows = await db
    .delete(mediaTable)
    .where(
      and(
        lt(mediaTable.createdAt, cutoff),
        notExists(db.select({ one: sql`1` }).from(postMediaTable).where(eq(postMediaTable.mediaId, mediaTable.id))),
        sql`not ${recurrenceMediaInUse}`,
        sql`not exists (select 1 from socialflow_library_items li where li.media_id = ${mediaTable.id})`,
      ),
    )
    .returning({ key: mediaTable.storageKey });
  await removeFiles(rows.map((row) => row.key));
  if (rows.length > 0) logger.info({ removed: rows.length }, "Removed abandoned media uploads");
  return rows.length;
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startMediaSweeper(): void {
  if (sweepTimer) return;
  const run = () => { sweepOrphanMedia().catch((error) => logger.error({ err: error }, "Media sweep failed")); };
  sweepTimer = setInterval(run, 60 * 60_000);
  sweepTimer.unref();
  run();
}

export function stopMediaSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

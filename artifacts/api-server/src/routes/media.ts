import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, mediaTable, postMediaTable } from "@workspace/db";
import { jsonError } from "../lib/http-errors";
import { ALLOWED_TYPES, discardRemainingBody, mediaConfig, pruneUnattachedMedia, saveUpload, serializeMedia, storedFilePath, verifyPublicMediaSignature } from "../lib/media";
import { requireAccess } from "../lib/access";
import type { WorkspaceContext } from "../lib/session";
import { rateLimit } from "../middlewares/rate-limit";

const router: IRouter = Router();

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.MEDIA_UPLOAD_RATE_LIMIT ?? 300),
  keyPrefix: "media:upload",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireWorkspace(req: Request, res: Response): Promise<WorkspaceContext | null> {
  return requireAccess(req, res, req.method === "GET" ? "posts:read" : "media:write");
}

/** A non-negative integer header within [0, max], or null. Display metadata only, so bad values are dropped, not rejected. */
function intHeader(req: Request, name: string, max: number): number | null {
  const raw = req.header(name);
  if (!raw || !/^\d{1,10}$/.test(raw)) return null;
  const value = Number(raw);
  return value <= max ? value : null;
}

/** What the uploader needs to validate files before sending them. The server still enforces every limit. */
router.get("/media/config", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const config = mediaConfig();
  res.json({
    maxImageBytes: config.maxImageBytes,
    maxVideoBytes: config.maxVideoBytes,
    maxFilesPerPost: config.maxFilesPerPost,
    allowedTypes: ALLOWED_TYPES.map(({ kind, mime, ext, label }) => ({ kind, mime, ext, label })),
  });
});

/**
 * Upload one file. The body is the raw file (not multipart) so the browser can
 * report real upload progress and the server can stream it to disk; the name
 * and display metadata travel in headers. The type is detected from the bytes.
 */
router.post("/media", uploadLimiter, async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;

  const declared = req.header("content-length");
  const declaredLength = declared && /^\d+$/.test(declared) ? Number(declared) : null;
  const result = await saveUpload(req, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    fileName: req.header("x-file-name"),
    declaredLength,
    width: intHeader(req, "x-media-width", 20_000),
    height: intHeader(req, "x-media-height", 20_000),
    durationMs: intHeader(req, "x-media-duration-ms", 24 * 3600_000),
  });
  if (!result.ok) {
    if (result.failure.status === 413) {
      await discardRemainingBody(req);
      res.setHeader("Connection", "close");
    }
    return jsonError(res, result.failure.status, result.failure.code, result.failure.message);
  }
  req.log.info({ mediaId: result.media.id, kind: result.media.kind, size: result.media.sizeBytes }, "Media uploaded");
  res.status(201).json(serializeMedia(result.media));
});

/**
 * Serves one file to anyone holding a valid signed link. These links exist so a network (Instagram) can fetch
 * media it is publishing; they expire, and each one only opens the single file it was signed for.
 */
router.get("/media/public/:mediaId", async (req, res): Promise<void> => {
  const id = String(req.params.mediaId);
  if (!UUID.test(id) || !verifyPublicMediaSignature(id, req.query.e, req.query.s)) return jsonError(res, 404, "not_found", "File not found.");
  const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, id)).limit(1);
  if (!row || !storedFilePath(row.storageKey)) return jsonError(res, 404, "not_found", "File not found.");
  res.sendFile(row.storageKey, {
    root: mediaConfig().storageDir,
    dotfiles: "allow",
    headers: { "Content-Type": row.mimeType, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=300" },
  }, (error) => {
    if (error && !res.headersSent) jsonError(res, 404, "not_found", "File not found.");
  });
});

/** Serves a file to signed-in members of the workspace that owns it. Supports Range so videos can seek. */
router.get("/media/:mediaId/file", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.mediaId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "File not found.");
  const [row] = await db.select().from(mediaTable).where(and(eq(mediaTable.id, id), eq(mediaTable.workspaceId, ctx.workspaceId))).limit(1);
  if (!row || !storedFilePath(row.storageKey)) return jsonError(res, 404, "not_found", "File not found.");

  res.sendFile(row.storageKey, {
    root: mediaConfig().storageDir,
    dotfiles: "allow",
    headers: {
      "Content-Type": row.mimeType,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.originalName)}`,
      "Cache-Control": "private, max-age=3600",
    },
  }, (error) => {
    if (error && !res.headersSent) jsonError(res, 404, "not_found", "File not found.");
  });
});

/** Deletes an upload that no post uses. Media attached to a post is detached by editing the post instead. */
router.delete("/media/:mediaId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.mediaId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "File not found.");
  const [row] = await db.select({ id: mediaTable.id }).from(mediaTable).where(and(eq(mediaTable.id, id), eq(mediaTable.workspaceId, ctx.workspaceId))).limit(1);
  if (!row) return jsonError(res, 404, "not_found", "File not found.");
  const [attached] = await db.select({ postId: postMediaTable.postId }).from(postMediaTable).where(eq(postMediaTable.mediaId, id)).limit(1);
  if (attached) return jsonError(res, 400, "media_in_use", "This file is attached to a post. Remove it from the post first.");
  await pruneUnattachedMedia(ctx.workspaceId, [id]);
  res.sendStatus(204);
});

export default router;

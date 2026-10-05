import { Router, type IRouter } from "express";
import { requireAccess } from "../lib/access";
import { jsonError } from "../lib/http-errors";
import { LinkPreviewError, fetchLinkPreview, fetchPublicImage } from "../lib/link-preview";
import { logger } from "../lib/logger";
import { rateLimit } from "../middlewares/rate-limit";

const router: IRouter = Router();

const limit = Number(process.env.LINK_PREVIEW_RATE_LIMIT);
const previewLimiter = rateLimit({ windowMs: 60_000, max: Number.isFinite(limit) && limit > 0 ? limit : 30, keyPrefix: "link-preview" });

router.get("/link-preview", previewLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "posts:write");
  if (!ctx) return;
  const url = req.query.url;
  if (typeof url !== "string" || url.trim().length === 0) return jsonError(res, 400, "invalid_url", "Enter a full link that starts with http:// or https://.");
  try {
    res.json(await fetchLinkPreview(url));
  } catch (error) {
    if (error instanceof LinkPreviewError) {
      return jsonError(res, error.code === "invalid_url" ? 400 : error.code === "no_preview" ? 422 : 502, error.code, error.message);
    }
    logger.error({ err: error }, "Link preview failed unexpectedly");
    return jsonError(res, 502, "fetch_failed", "The link couldn't be previewed. Try again.");
  }
});

/*
 * The link's preview picture, served from our own origin. Browsers loading the picture straight from the other
 * website can be stopped by hotlink protection, a blocked network, an ad blocker or privacy settings, which leaves
 * the card empty; fetched here, it always shows. Same SSRF-safe fetcher as the preview itself, raster images only
 * (never SVG), size-capped, and served with headers that stop the browser treating it as anything but an image.
 */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_CACHE_ENTRIES = 40;
const IMAGE_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const IMAGE_CACHE_TTL_MS = 30 * 60_000;
const imageCache = new Map<string, { at: number; bytes: Buffer; mimeType: string }>();
let imageCacheBytes = 0;

function cacheImage(url: string, bytes: Buffer, mimeType: string): void {
  const old = imageCache.get(url);
  if (old) { imageCache.delete(url); imageCacheBytes -= old.bytes.length; }
  imageCache.set(url, { at: Date.now(), bytes, mimeType });
  imageCacheBytes += bytes.length;
  while (imageCache.size > IMAGE_CACHE_ENTRIES || imageCacheBytes > IMAGE_CACHE_MAX_BYTES) {
    const [key, entry] = imageCache.entries().next().value as [string, { bytes: Buffer }];
    imageCache.delete(key);
    imageCacheBytes -= entry.bytes.length;
  }
}

const imageLimiter = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: "link-preview-image" });

router.get("/link-preview/image", imageLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "posts:read");
  if (!ctx) return;
  const url = req.query.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim()) || url.length > 2048) return jsonError(res, 400, "invalid_url", "That isn't a picture address.");
  const key = url.trim();
  let hit = imageCache.get(key);
  if (hit && Date.now() - hit.at > IMAGE_CACHE_TTL_MS) { imageCache.delete(key); imageCacheBytes -= hit.bytes.length; hit = undefined; }
  if (!hit) {
    try {
      const image = await fetchPublicImage(key, IMAGE_MAX_BYTES);
      cacheImage(key, image.bytes, image.mimeType);
      hit = imageCache.get(key)!;
    } catch (error) {
      if (error instanceof LinkPreviewError) return jsonError(res, error.code === "invalid_url" ? 400 : 502, error.code, error.message);
      logger.warn({ errorName: error instanceof Error ? error.name : typeof error }, "Link preview image failed");
      return jsonError(res, 502, "fetch_failed", "The picture couldn't be loaded.");
    }
  }
  res.set({
    "content-type": hit.mimeType,
    "content-length": String(hit.bytes.length),
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
  });
  res.end(hit.bytes);
});

export default router;

import sharp from "sharp";
import { fetchPublicImage } from "./link-preview";
import { saveGeneratedImage, mediaConfig, signedPublicMediaUrl, storedFilePath } from "./media";
import type { PublishMedia } from "./oauth/types";

/*
 * A link's preview picture as an Instagram photo.
 *
 * Instagram can't show a link card and can't publish text alone, so a post that has a link and no attached photo
 * or video posts the link's own preview picture instead. Instagram only takes JPEG, fetches the file itself, and
 * refuses images outside its size and shape limits, so rather than handing it the website's URL (a PNG, a WebP or
 * a host that blocks Instagram would all fail at publish time) the picture is downloaded here with the SSRF-safe
 * fetcher, converted to a JPEG that fits Instagram's rules, and saved as a real upload in this workspace's media
 * storage, exactly like a file the user attached. Instagram then fetches it from us, the same way it fetches every
 * other photo. The saved file isn't attached to the post (that would turn the Facebook and LinkedIn link cards
 * into photo posts), so the orphan sweeper removes it after a day.
 */

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
// Instagram's published limits for a single photo: 320–1440 px wide, aspect ratio between 4:5 and 1.91:1, JPEG.
const MAX_WIDTH = 1440;
const MIN_WIDTH = 320;
const MIN_RATIO = 4 / 5;
const MAX_RATIO = 1.91;

/** Downloads the picture and produces a JPEG within Instagram's limits: resized to fit, and padded (never cropped) into the allowed shape. */
export async function instagramJpegFromUrl(imageUrl: string): Promise<{ bytes: Buffer; width: number; height: number }> {
  const source = await fetchPublicImage(imageUrl, MAX_SOURCE_BYTES);
  // `rotate()` with no angle applies the EXIF orientation so the saved photo isn't sideways.
  let image = sharp(source.bytes, { limitInputPixels: 40_000_000 }).rotate();
  const meta = await image.metadata();
  let width = meta.width ?? 0;
  let height = meta.height ?? 0;
  if (!width || !height) throw new Error("The picture's size couldn't be read.");

  if (width > MAX_WIDTH) {
    height = Math.round((height * MAX_WIDTH) / width);
    width = MAX_WIDTH;
    image = image.resize({ width: MAX_WIDTH });
  } else if (width < MIN_WIDTH) {
    height = Math.round((height * MIN_WIDTH) / width);
    width = MIN_WIDTH;
    image = image.resize({ width: MIN_WIDTH });
  }

  const ratio = width / height;
  if (ratio > MAX_RATIO) {
    // Too wide: add equal bands above and below.
    const targetHeight = Math.ceil(width / MAX_RATIO);
    const pad = targetHeight - height;
    image = image.extend({ top: Math.floor(pad / 2), bottom: Math.ceil(pad / 2), background: "#ffffff" });
    height = targetHeight;
  } else if (ratio < MIN_RATIO) {
    // Too tall: add equal bands left and right.
    const targetWidth = Math.ceil(height * MIN_RATIO);
    const pad = targetWidth - width;
    image = image.extend({ left: Math.floor(pad / 2), right: Math.ceil(pad / 2), background: "#ffffff" });
    width = targetWidth;
  }

  const bytes = await image.flatten({ background: "#ffffff" }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  if (bytes.length > mediaConfig().maxImageBytes) throw new Error("The converted picture is larger than the image limit.");
  return { bytes, width, height };
}

/** The link's picture, converted and stored, as media the Instagram adapter can publish. */
export async function prepareLinkPhoto(workspaceId: string, userId: string | null, imageUrl: string): Promise<PublishMedia> {
  const { bytes, width, height } = await instagramJpegFromUrl(imageUrl);
  let name = "link-preview.jpg";
  try { name = `${new URL(imageUrl).hostname.replace(/^www\./, "")}-preview.jpg`; } catch { /* keep the default name */ }
  const row = await saveGeneratedImage({ workspaceId, userId, bytes, mimeType: "image/jpeg", ext: ".jpg", originalName: name, width, height });
  const filePath = storedFilePath(row.storageKey);
  if (!filePath) throw new Error("The stored picture has no file path.");
  return { kind: "image", mimeType: "image/jpeg", fileName: row.originalName, sizeBytes: row.sizeBytes, filePath, publicUrl: signedPublicMediaUrl(row.id) };
}

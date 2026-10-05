import type { Platform } from "./oauth/types";

/*
 * What each network accepts as a post's media. One source of truth for the API and the publisher; the composer
 * mirrors these rules (artifacts/socialflow/src/app/media-rules.ts) so users see the same reason before saving.
 *
 * Formats follow each network's documented upload formats. Where a network's docs don't list a format (WebP on
 * Facebook, WebM anywhere), it is refused here with a clear message instead of being sent and failing later.
 */

export type RuleMedia = { kind: "image" | "video"; mimeType: string; sizeBytes?: number };

const NAMES: Record<Platform, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", youtube: "YouTube", twitter: "X" };

const isJpeg = (m: RuleMedia) => m.mimeType === "image/jpeg";
const isPngJpeg = (m: RuleMedia) => m.mimeType === "image/jpeg" || m.mimeType === "image/png";
const isMp4OrMov = (m: RuleMedia) => m.mimeType === "video/mp4" || m.mimeType === "video/quicktime";
const isGif = (m: RuleMedia) => m.mimeType === "image/gif";
const MB = 1024 * 1024;

export type MediaRuleOptions = {
  /** The post has a link whose preview has a picture Instagram can use as the post's photo instead of an upload. */
  hasLinkImage?: boolean;
};

/** Why this network can't take these files (or none), or null when it can. Text-only posts pass except where media is required. */
export function mediaProblemForPlatform(platform: Platform, media: RuleMedia[], options: MediaRuleOptions = {}): string | null {
  const name = NAMES[platform];
  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");

  if (platform === "youtube") {
    // YouTube's API can't post a standalone photo. An image can be the video's custom thumbnail (JPG or PNG, up to 2 MB).
    if (videos.length === 0) return images.length > 0 ? "YouTube can't post a photo on its own. Add a video, and the photo becomes its thumbnail." : "YouTube posts need a video.";
    if (videos.length > 1) return "YouTube posts can have one video.";
    if (images.length > 1) return "YouTube uses one photo, as the video's thumbnail.";
    const thumb = images[0];
    if (thumb && !isPngJpeg(thumb)) return "A YouTube thumbnail must be a JPG or PNG.";
    if (thumb && typeof thumb.sizeBytes === "number" && thumb.sizeBytes > 2 * 1024 * 1024) return "A YouTube thumbnail can be up to 2 MB.";
    return null;
  }

  if (platform === "instagram") {
    // Instagram has no clickable link and no text-only post, but a link's own preview picture can stand in as the
    // photo when nothing else is attached (see the note on publishPost in oauth/providers/instagram.ts).
    if (media.length === 0) return options.hasLinkImage ? null : "Instagram posts need an image or video.";
    if (media.length > 10) return "Instagram allows up to 10 files in one post.";
    if (images.some((m) => !isJpeg(m))) return "Instagram accepts JPG images only. Convert PNG, GIF and WebP files to JPG.";
    if (videos.some((m) => !isMp4OrMov(m))) return "Instagram accepts MP4 and MOV video only.";
    return null;
  }

  if (media.length === 0) return null;

  if (platform === "facebook") {
    if (videos.length > 0 && images.length > 0) return "Facebook posts can have photos or one video, not both.";
    if (videos.length > 1) return "Facebook posts can have one video.";
    if (videos.some((m) => !isMp4OrMov(m))) return "Facebook accepts MP4 and MOV video here.";
    if (images.length > 10) return "Facebook allows up to 10 photos in one post.";
    if (images.some((m) => m.mimeType === "image/webp")) return "Facebook accepts JPG, PNG and GIF images here. Convert WebP files first.";
    if (images.length > 1 && images.some((m) => m.mimeType === "image/gif")) return "A GIF has to be posted on its own on Facebook.";
    return null;
  }

  if (platform === "twitter") {
    // X: up to four photos, or one GIF, or one video. Photos up to 5 MB, a GIF up to 15 MB.
    if (videos.length > 0 && images.length > 0) return "X posts can have photos or one video, not both.";
    if (videos.length > 1) return "X posts can have one video.";
    if (videos.some((m) => !isMp4OrMov(m))) return "X accepts MP4 and MOV video only.";
    if (images.some(isGif) && images.length > 1) return "A GIF has to be posted on its own on X.";
    if (images.length > 4) return "X allows up to 4 photos in one post.";
    if (images.some((m) => !isPngJpeg(m) && !isGif(m) && m.mimeType !== "image/webp")) return "X accepts JPG, PNG, WebP and GIF images.";
    if (images.some((m) => !isGif(m) && typeof m.sizeBytes === "number" && m.sizeBytes > 5 * MB)) return "A photo on X can be up to 5 MB.";
    if (images.some((m) => isGif(m) && typeof m.sizeBytes === "number" && m.sizeBytes > 15 * MB)) return "A GIF on X can be up to 15 MB.";
    return null;
  }

  // linkedin
  if (videos.length > 0 && images.length > 0) return `${name} posts can have images or one video, not both.`;
  if (videos.length > 1) return `${name} posts can have one video.`;
  if (videos.some((m) => m.mimeType !== "video/mp4")) return "LinkedIn accepts MP4 video only.";
  if (images.length > 9) return "LinkedIn allows up to 9 images in one post.";
  if (images.some((m) => !isPngJpeg(m) && m.mimeType !== "image/gif")) return "LinkedIn accepts JPG, PNG and GIF images.";
  return null;
}

/** One message covering every selected network, or null when all of them can take the media. */
export function mediaProblemForPlatforms(platforms: Platform[], media: RuleMedia[], options: MediaRuleOptions = {}): string | null {
  const problems: string[] = [];
  for (const platform of [...new Set(platforms)]) {
    const problem = mediaProblemForPlatform(platform, media, options);
    if (problem) problems.push(problem);
  }
  return problems.length > 0 ? problems.join(" ") : null;
}

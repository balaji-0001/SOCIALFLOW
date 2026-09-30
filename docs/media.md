# Media uploads

The Create Post composer has a media uploader for images and video. It uses real storage and a real API; nothing is mocked.

## What works

- Drag and drop, or Browse / the toolbar image button; several files at once.
- Real upload progress (per file), retry on failure, cancel by removing the tile.
- Thumbnails; video tiles show a poster frame and duration (read in the browser).
- Preview (lightbox) for images and video, with seeking for video.
- Remove and reorder (drag, or the arrow buttons). The order is saved with the post; the first file leads.
- Validation before upload, with the reason shown on the tile, and again on the server.
- Media is saved with the post (drafts). Removing media from a post, or deleting the post, deletes the files. Closing the composer without saving deletes files uploaded in that session.

## Limits (defaults, all overridable)

| Setting | Default | Env var |
| --- | --- | --- |
| Image size | 10 MB | `MEDIA_MAX_IMAGE_BYTES` |
| Video size | 200 MB | `MEDIA_MAX_VIDEO_BYTES` |
| Files per post | 10 | `MEDIA_MAX_FILES_PER_POST` |
| Storage per workspace | 2 GB | `MEDIA_WORKSPACE_QUOTA_BYTES` |
| Uploads never attached to a post are swept after | 24 h | `MEDIA_ORPHAN_MAX_AGE_HOURS` |
| Storage directory | `.data/media` (git-ignored) | `MEDIA_STORAGE_DIR` |

Accepted types: JPG, PNG, GIF, WebP, MP4, MOV, WebM. The type is detected from the file's bytes; the file name and the browser's Content-Type are never trusted, so SVG/HTML/executables renamed to `.png` are rejected.

## API

- `GET /api/media/config` limits and allowed types (used by the uploader).
- `POST /api/media` raw file body (`Content-Type: application/octet-stream`), headers `X-File-Name` (URI-encoded) and optional `X-Media-Width`, `X-Media-Height`, `X-Media-Duration-Ms`. Returns the media object. Errors: `file_too_large`, `quota_exceeded`, `unsupported_type`, `empty_file`, `upload_aborted`.
- `GET /api/media/:id/file` authenticated, same workspace only, supports Range.
- `DELETE /api/media/:id` only for files no post uses.
- Posts carry `media` (ordered) and accept `mediaIds` on create/update (omit on update to leave unchanged).

## Publishing media to networks

Media is sent when the post is published (Publish now or the scheduler). Rules live in `api-server/src/lib/media-rules.ts` (mirrored in the composer); scheduling or publishing a post the selected networks can't take is refused with the reason, and drafts are never blocked.

| Network | What is sent | Accepted |
| --- | --- | --- |
| Facebook Page | 1 photo with caption, several photos as one post, or 1 video (uploaded as bytes) | JPG/PNG (GIF alone); MP4/MOV; up to 10 photos; photos or a video, not both |
| Instagram | 1 image, 1 video (published as a Reel), or a carousel of 2-10 | JPG images only; MP4/MOV. Always needs media |
| LinkedIn | 1-9 images or 1 video (register upload, then PUT the bytes, then UGC post) | JPG/PNG/GIF; MP4 |
| YouTube | 1 video, uploaded with the resumable upload protocol. First line of the text = title (100 chars max), whole text = description. An optional 1 photo (JPG/PNG, up to 2 MB) is set as the video's custom thumbnail | MP4/MOV/WebM; exactly one video; no `<` or `>` in the text. A photo alone is refused: YouTube's API has no photo posts |

Instagram downloads media from a URL instead of receiving bytes, so the app hands it a time-limited signed link (`/api/media/public/:id?e=&s=`, 2 hours, one file each). This requires `OAUTH_REDIRECT_BASE_URL` to be a public **https** address that reaches this API (your tunnel or production domain); otherwise Instagram posts fail with that explanation. Instagram processing is polled for up to 7 minutes; a slow video fails without publishing and can be retried.

YouTube custom thumbnails need a verified channel (phone-verified). If YouTube refuses the thumbnail the video is still published and the post shows a note saying so.

YouTube uploads are **private** unless `YOUTUBE_DEFAULT_PRIVACY=unlisted|public` is set. Google keeps videos from API projects it has not audited private regardless, so leave the default until the project passes the audit. Each upload costs ~1,600 of the default 10,000 daily quota units (about 6 uploads a day).

Verification status, stated plainly: all four adapters are covered by tests against faked network endpoints that assert the exact requests (fields, order, files). Facebook uses documented Graph API calls. Instagram, LinkedIn and YouTube media publishing have **not** yet been exercised against the live networks, so a first real post may surface a network-specific requirement (for example an app review permission). Errors from the network are shown on the post as-is.

## Not built (stated plainly)

- **Local-disk storage.** Files live on the API server's disk. A multi-instance or ephemeral deployment needs object storage (S3 or similar) behind `lib/media.ts`.
- No server-side thumbnails or transcoding; previews come from the original file. A video the browser can't decode (some MOV/HEVC files) still uploads but shows "No preview". WebM and WebP can be uploaded and previewed but no network here accepts them, so posts with them stay drafts.
- No crop, trim or filters.

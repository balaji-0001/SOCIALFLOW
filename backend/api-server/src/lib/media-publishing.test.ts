import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signedPublicMediaUrl, verifyPublicMediaSignature } from "./media";
import { mediaProblemForPlatform, mediaProblemForPlatforms } from "./media-rules";
import { OAuthError } from "./oauth/errors";
import { createFacebookAdapter } from "./oauth/providers/facebook";
import { createInstagramAdapter } from "./oauth/providers/instagram";
import { createLinkedInAdapter } from "./oauth/providers/linkedin";
import { createYouTubeAdapter, youtubeTitleAndDescription } from "./oauth/providers/youtube";
import type { PublishMedia } from "./oauth/types";

// Media publishing for each network's adapter, against faked network endpoints. No real network is contacted.

const dir = mkdtempSync(join(tmpdir(), "socialflow-publish-media-"));
const file = (name: string, size: number) => { const p = join(dir, name); writeFileSync(p, Buffer.alloc(size, 9)); return p; };
const media = (name: string, kind: "image" | "video", mimeType: string, size = 500, publicUrl: string | null = `https://socialflow.test/api/media/public/${name}?e=1&s=x`): PublishMedia =>
  ({ kind, mimeType, fileName: name, sizeBytes: size, filePath: file(name, size), publicUrl });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("per-network media rules", () => {
  const jpg = { kind: "image", mimeType: "image/jpeg" } as const;
  const png = { kind: "image", mimeType: "image/png" } as const;
  const gif = { kind: "image", mimeType: "image/gif" } as const;
  const webp = { kind: "image", mimeType: "image/webp" } as const;
  const mp4 = { kind: "video", mimeType: "video/mp4" } as const;
  const mov = { kind: "video", mimeType: "video/quicktime" } as const;
  const webm = { kind: "video", mimeType: "video/webm" } as const;

  it("Facebook: photos or one video", () => {
    expect(mediaProblemForPlatform("facebook", [])).toBeNull();
    expect(mediaProblemForPlatform("facebook", [jpg, png, gif].slice(0, 2))).toBeNull();
    expect(mediaProblemForPlatform("facebook", [gif])).toBeNull();
    expect(mediaProblemForPlatform("facebook", [mp4])).toBeNull();
    expect(mediaProblemForPlatform("facebook", [mov])).toBeNull();
    expect(mediaProblemForPlatform("facebook", [jpg, mp4])).toContain("photos or one video");
    expect(mediaProblemForPlatform("facebook", [mp4, mp4])).toContain("one video");
    expect(mediaProblemForPlatform("facebook", [webm])).toContain("MP4 and MOV");
    expect(mediaProblemForPlatform("facebook", [webp])).toContain("WebP");
    expect(mediaProblemForPlatform("facebook", [jpg, gif])).toContain("GIF");
  });
  it("Instagram: needs media; JPEG images and MP4/MOV video; up to 10", () => {
    expect(mediaProblemForPlatform("instagram", [])).toContain("need an image or video");
    expect(mediaProblemForPlatform("instagram", [jpg])).toBeNull();
    expect(mediaProblemForPlatform("instagram", [mp4])).toBeNull();
    expect(mediaProblemForPlatform("instagram", [jpg, mp4, mov])).toBeNull();
    expect(mediaProblemForPlatform("instagram", [png])).toContain("JPG images only");
    expect(mediaProblemForPlatform("instagram", [webm])).toContain("MP4 and MOV");
    expect(mediaProblemForPlatform("instagram", Array(11).fill(jpg))).toContain("up to 10");
  });
  it("Instagram: a link's preview picture stands in for media, but only when nothing else is attached", () => {
    expect(mediaProblemForPlatform("instagram", [], { hasLinkImage: true })).toBeNull();
    expect(mediaProblemForPlatform("instagram", [], { hasLinkImage: false })).toContain("need an image or video");
    expect(mediaProblemForPlatform("instagram", [png], { hasLinkImage: true })).toContain("JPG images only"); // still checked once real media is attached
  });
  it("LinkedIn: images or one MP4", () => {
    expect(mediaProblemForPlatform("linkedin", [])).toBeNull();
    expect(mediaProblemForPlatform("linkedin", [jpg, png, gif])).toBeNull();
    expect(mediaProblemForPlatform("linkedin", [mp4])).toBeNull();
    expect(mediaProblemForPlatform("linkedin", [mov])).toContain("MP4 video only");
    expect(mediaProblemForPlatform("linkedin", [jpg, mp4])).toContain("not both");
    expect(mediaProblemForPlatform("linkedin", [webp])).toContain("JPG, PNG and GIF");
  });
  it("YouTube: exactly one video (MP4, MOV or WebM)", () => {
    expect(mediaProblemForPlatform("youtube", [mp4])).toBeNull();
    expect(mediaProblemForPlatform("youtube", [webm])).toBeNull();
    expect(mediaProblemForPlatform("youtube", [])).toContain("need a video");
    expect(mediaProblemForPlatform("youtube", [jpg])).toContain("on its own");
    expect(mediaProblemForPlatform("youtube", [mp4, jpg])).toBeNull(); // the photo is the thumbnail
    expect(mediaProblemForPlatform("youtube", [mp4, png])).toBeNull();
    expect(mediaProblemForPlatform("youtube", [mp4, gif])).toContain("JPG or PNG");
    expect(mediaProblemForPlatform("youtube", [mp4, { ...jpg, sizeBytes: 3 * 1024 * 1024 }])).toContain("2 MB");
    expect(mediaProblemForPlatform("youtube", [mp4, jpg, png])).toContain("one photo");
    expect(mediaProblemForPlatform("youtube", [mp4, mov])).toContain("one video");
  });
  it("networks are combined into one message", () => {
    expect(mediaProblemForPlatforms(["facebook", "instagram"], [png])).toContain("JPG images only");
    expect(mediaProblemForPlatforms(["facebook", "linkedin"], [jpg])).toBeNull();
  });
});

describe("signed public media links", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("verifies, expires, and can't be moved to another file or edited", () => {
    const url = new URL(signedPublicMediaUrl(id)!);
    expect(url.origin).toBe("https://socialflow.test");
    expect(url.pathname).toBe(`/api/media/public/${id}`);
    const e = url.searchParams.get("e"), s = url.searchParams.get("s");
    expect(verifyPublicMediaSignature(id, e, s)).toBe(true);
    expect(verifyPublicMediaSignature("22222222-2222-4222-8222-222222222222", e, s)).toBe(false);
    expect(verifyPublicMediaSignature(id, String(Number(e) + 1), s)).toBe(false);
    expect(verifyPublicMediaSignature(id, e, s + "x")).toBe(false);
    expect(verifyPublicMediaSignature(id, e, undefined)).toBe(false);
    expect(verifyPublicMediaSignature(id, e, s, Date.now() + 3 * 3600_000)).toBe(false);
  });
  it("is not produced without a public https address", () => {
    vi.stubEnv("OAUTH_REDIRECT_BASE_URL", "http://localhost:5000");
    expect(signedPublicMediaUrl(id)).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("Facebook media publishing", () => {
  const adapter = createFacebookAdapter({ clientId: "app", clientSecret: "secret" });
  const account = { externalAccountId: "1001", accessToken: "PAGE_TOKEN", refreshToken: null, tokenExpiresAt: null };

  function fakeFacebook() {
    const calls: Array<{ path: string; fields: Record<string, string>; file?: { name: string; size: number } }> = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const form = init?.body as FormData;
      const fields: Record<string, string> = {};
      let fileInfo: { name: string; size: number } | undefined;
      for (const [k, v] of form.entries()) { if (typeof v === "string") fields[k] = v; else fileInfo = { name: v.name, size: v.size }; }
      calls.push({ path: url.pathname.replace(/^\/v[\d.]+/, ""), fields, file: fileInfo });
      n += 1;
      if (url.pathname.endsWith("/videos")) return json({ id: "vid1" });
      if (url.pathname.endsWith("/feed")) return json({ id: "1001_feed" });
      return json(fields.published === "false" ? { id: `photo${n}` } : { id: `photo${n}`, post_id: "1001_photo" });
    }));
    return calls;
  }

  it("posts one photo with its caption", async () => {
    const calls = fakeFacebook();
    const result = await adapter.publishPost!(account, { text: "Hello", media: [media("a.jpg", "image", "image/jpeg", 1234)] });
    expect(result.externalPostId).toBe("1001_photo");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/1001/photos");
    expect(calls[0]!.fields).toMatchObject({ caption: "Hello", published: "true", access_token: "PAGE_TOKEN" });
    expect(calls[0]!.fields.appsecret_proof).toBeTruthy();
    expect(calls[0]!.file).toEqual({ name: "a.jpg", size: 1234 });
  });

  it("posts several photos as one post, in the arranged order", async () => {
    const calls = fakeFacebook();
    const result = await adapter.publishPost!(account, { text: "Album", media: [media("1.jpg", "image", "image/jpeg"), media("2.png", "image", "image/png"), media("3.jpg", "image", "image/jpeg")] });
    expect(result.externalPostId).toBe("1001_feed");
    expect(calls.map((c) => c.path)).toEqual(["/1001/photos", "/1001/photos", "/1001/photos", "/1001/feed"]);
    expect(calls.slice(0, 3).every((c) => c.fields.published === "false")).toBe(true);
    expect(calls.slice(0, 3).map((c) => c.file!.name)).toEqual(["1.jpg", "2.png", "3.jpg"]);
    const feed = calls[3]!.fields;
    expect(feed.message).toBe("Album");
    expect([0, 1, 2].map((i) => JSON.parse(feed[`attached_media[${i}]`]!).media_fbid)).toEqual(["photo1", "photo2", "photo3"]);
  });

  it("posts a video with its description", async () => {
    const calls = fakeFacebook();
    const result = await adapter.publishPost!(account, { text: "Watch", media: [media("c.mp4", "video", "video/mp4", 5000)] });
    expect(result.externalPostId).toBe("vid1");
    expect(calls[0]!.path).toBe("/1001/videos");
    expect(calls[0]!.fields.description).toBe("Watch");
    expect(calls[0]!.file).toEqual({ name: "c.mp4", size: 5000 });
  });

  it("reports the network's error, and permission errors map to insufficient_permissions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: 200, message: "Permissions error" } }, 403)));
    await expect(adapter.publishPost!(account, { text: "x", media: [media("a.jpg", "image", "image/jpeg")] })).rejects.toMatchObject({ code: "insufficient_permissions" });
  });
});

describe("Instagram media publishing", () => {
  process.env.INSTAGRAM_POLL_INTERVAL_MS = "1";
  const adapter = createInstagramAdapter({ clientId: "app", clientSecret: "secret" });
  const account = { externalAccountId: "ig-9", accessToken: "IG_TOKEN", refreshToken: null, tokenExpiresAt: null };

  function fakeInstagram(statuses: Record<string, string[]> = {}) {
    const posts: Array<{ path: string; params: Record<string, string> }> = [];
    const polls: string[] = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.hostname !== "graph.instagram.com") throw new Error(`Unexpected host ${url.hostname}`);
      if (init?.method === "POST") {
        const params = Object.fromEntries(new URLSearchParams(String(init.body)));
        posts.push({ path: url.pathname, params });
        if (url.pathname.endsWith("/media_publish")) return json({ id: "media-final" });
        return json({ id: `container${++n}` });
      }
      const id = url.pathname.slice(1);
      polls.push(id);
      const queue = statuses[id] ?? ["FINISHED"];
      const status = queue.length > 1 ? queue.shift()! : queue[0]!;
      return json({ status_code: status, id, ...(status === "ERROR" ? { status: "Error: video too short" } : {}) });
    }));
    return { posts, polls };
  }

  it("publishes one JPEG: create container, wait for FINISHED, publish", async () => {
    const { posts, polls } = fakeInstagram({ container1: ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"] });
    const result = await adapter.publishPost!(account, { text: "Caption #x", media: [media("a.jpg", "image", "image/jpeg")] });
    expect(result.externalPostId).toBe("media-final");
    expect(posts[0]).toMatchObject({ path: "/ig-9/media", params: { image_url: expect.stringContaining("/api/media/public/a.jpg"), caption: "Caption #x", access_token: "IG_TOKEN" } });
    expect(polls.filter((p) => p === "container1").length).toBe(3);
    expect(posts[1]).toMatchObject({ path: "/ig-9/media_publish", params: { creation_id: "container1" } });
  });

  it("publishes a single video as a Reel", async () => {
    const { posts } = fakeInstagram();
    await adapter.publishPost!(account, { text: "Reel", media: [media("r.mp4", "video", "video/mp4")] });
    expect(posts[0]!.params).toMatchObject({ media_type: "REELS", video_url: expect.stringContaining("r.mp4"), caption: "Reel" });
    expect(posts[0]!.params.image_url).toBeUndefined();
  });

  it("publishes several files as a carousel of processed children, in order", async () => {
    const { posts } = fakeInstagram();
    await adapter.publishPost!(account, { text: "Swipe", media: [media("1.jpg", "image", "image/jpeg"), media("2.mp4", "video", "video/mp4"), media("3.jpg", "image", "image/jpeg")] });
    expect(posts.map((p) => p.path)).toEqual(["/ig-9/media", "/ig-9/media", "/ig-9/media", "/ig-9/media", "/ig-9/media_publish"]);
    expect(posts[0]!.params).toMatchObject({ is_carousel_item: "true", image_url: expect.stringContaining("1.jpg") });
    expect(posts[1]!.params).toMatchObject({ is_carousel_item: "true", media_type: "VIDEO", video_url: expect.stringContaining("2.mp4") });
    expect(posts[3]!.params).toMatchObject({ media_type: "CAROUSEL", children: "container1,container2,container3", caption: "Swipe" });
    expect(posts[4]!.params.creation_id).toBe("container4");
  });

  it("does not publish when Instagram can't process the media, and says why", async () => {
    const { posts } = fakeInstagram({ container1: ["IN_PROGRESS", "ERROR"] });
    const error = await adapter.publishPost!(account, { text: "x", media: [media("r.mp4", "video", "video/mp4")] }).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.details.providerMessage).toContain("couldn't process the media: Error: video too short");
    expect(posts.some((p) => p.path.endsWith("/media_publish"))).toBe(false);
  });

  it("explains when the app has no public https address to give Instagram", async () => {
    const { posts } = fakeInstagram();
    const error = await adapter.publishPost!(account, { text: "x", media: [media("a.jpg", "image", "image/jpeg", 500, null)] }).catch((e) => e);
    expect(error.details.providerMessage).toContain("public https address");
    expect(posts).toHaveLength(0);
  });

  it("refuses a post with no media", async () => {
    fakeInstagram();
    await expect(adapter.publishPost!(account, { text: "x" })).rejects.toBeInstanceOf(OAuthError);
  });

  it("refuses a post with a link that has no preview image either", async () => {
    fakeInstagram();
    const error = await adapter.publishPost!(account, { text: "x", link: { url: "https://a.test", title: null, description: null, imageUrl: null } }).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.details.providerMessage).toContain("need an image or video");
  });

  // Instagram has no clickable link and no text-only post, so a link with a preview picture and nothing else
  // attached uses that picture as the post's photo. Instagram fetches it itself from the URL we give it (the same
  // way it fetches our own uploads), so unlike LinkedIn's thumbnail there is nothing to download and re-host.
  it("uses the link's preview picture as the post's photo when nothing else is attached", async () => {
    const { posts } = fakeInstagram();
    const result = await adapter.publishPost!(account, { text: "Worth a read", link: { url: "https://a.test/story", title: "T", description: "D", imageUrl: "https://cdn.a.test/card.png" } });
    expect(result.externalPostId).toBe("media-final");
    expect(posts[0]).toMatchObject({ path: "/ig-9/media", params: { image_url: "https://cdn.a.test/card.png", caption: "Worth a read" } });
    expect(result.notice).toMatch(/preview picture was posted as the photo/);
  });

  it("posts the attached media as usual, ignoring the link's picture, when media is also attached", async () => {
    const { posts } = fakeInstagram();
    const result = await adapter.publishPost!(account, { text: "x", media: [media("a.jpg", "image", "image/jpeg")], link: { url: "https://a.test/story", title: null, description: null, imageUrl: "https://cdn.a.test/card.png" } });
    expect(posts[0]!.params.image_url).toContain("a.jpg");
    expect(result.notice).toBeUndefined();
  });
});

describe("LinkedIn media publishing", () => {
  const adapter = createLinkedInAdapter({ clientId: "id", clientSecret: "secret" });

  function fakeLinkedIn() {
    const calls: Array<{ method: string; url: string; body?: unknown; bytes?: number; contentType?: string | null }> = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
      const headers = new Headers(init?.headers);
      if (init?.method === "PUT") {
        calls.push({ method: "PUT", url, bytes: (init.body as Blob).size, contentType: headers.get("content-type") });
        return new Response(null, { status: 201 });
      }
      const body = JSON.parse(String(init?.body));
      calls.push({ method: "POST", url, body });
      if (url.includes("registerUpload")) {
        n += 1;
        return json({ value: { asset: `urn:li:digitalmediaAsset:A${n}`, uploadMechanism: { "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: `https://upload.linkedin.test/u${n}` } } } });
      }
      return json({ id: "urn:li:share:123" });
    }));
    return calls;
  }
  const account = { externalAccountId: "abc", accessToken: "LI_TOKEN", refreshToken: null, tokenExpiresAt: null, accountType: "linkedin_member" };

  it("registers, uploads and references each image", async () => {
    const calls = fakeLinkedIn();
    const result = await adapter.publishPost!(account, { text: "Pics", media: [media("a.jpg", "image", "image/jpeg", 700), media("b.png", "image", "image/png", 900)] });
    expect(result.externalPostId).toBe("urn:li:share:123");
    const register = calls.filter((c) => c.url.includes("registerUpload"));
    expect(register).toHaveLength(2);
    expect((register[0]!.body as any).registerUploadRequest).toMatchObject({ recipes: ["urn:li:digitalmediaRecipe:feedshare-image"], owner: "urn:li:person:abc" });
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((p) => [p.url, p.bytes, p.contentType])).toEqual([["https://upload.linkedin.test/u1", 700, "image/jpeg"], ["https://upload.linkedin.test/u2", 900, "image/png"]]);
    const post = calls.find((c) => c.url.endsWith("/ugcPosts"))!.body as any;
    const content = post.specificContent["com.linkedin.ugc.ShareContent"];
    expect(content.shareMediaCategory).toBe("IMAGE");
    expect(content.media).toEqual([{ status: "READY", media: "urn:li:digitalmediaAsset:A1" }, { status: "READY", media: "urn:li:digitalmediaAsset:A2" }]);
  });

  it("posts a video as an organization", async () => {
    const calls = fakeLinkedIn();
    await adapter.publishPost!({ ...account, accountType: "linkedin_organization" }, { text: "Vid", media: [media("v.mp4", "video", "video/mp4", 2000)] });
    expect((calls[0]!.body as any).registerUploadRequest).toMatchObject({ recipes: ["urn:li:digitalmediaRecipe:feedshare-video"], owner: "urn:li:organization:abc" });
    expect((calls.find((c) => c.url.endsWith("/ugcPosts"))!.body as any).specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory).toBe("VIDEO");
  });

  it("stays text-only when there is no media", async () => {
    const calls = fakeLinkedIn();
    await adapter.publishPost!(account, { text: "Just text" });
    expect(calls).toHaveLength(1);
    const content = (calls[0]!.body as any).specificContent["com.linkedin.ugc.ShareContent"];
    expect(content.shareMediaCategory).toBe("NONE");
    expect(content.media).toBeUndefined();
  });
});

describe("YouTube video publishing", () => {
  const adapter = createYouTubeAdapter({ clientId: "id", clientSecret: "secret" });
  const account = { externalAccountId: "UC123", accessToken: "YT_TOKEN", refreshToken: "r", tokenExpiresAt: null };

  function fakeYouTube(options: { sessionStatus?: number; sessionBody?: unknown; putStatus?: number; putBody?: unknown } = {}) {
    const calls: Array<{ method: string; url: string; headers: Headers; body?: any; bytes?: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
      const headers = new Headers(init?.headers);
      if (init?.method === "PUT") {
        calls.push({ method: "PUT", url, headers, bytes: (init.body as Blob).size });
        return json(options.putBody ?? { id: "vid123", kind: "youtube#video" }, options.putStatus ?? 200);
      }
      if (url.includes("thumbnails/set")) { calls.push({ method: "POST", url, headers, bytes: (init?.body as Blob).size }); return json({ items: [{}] }); }
      calls.push({ method: "POST", url, headers, body: JSON.parse(String(init?.body)) });
      if (options.sessionStatus && options.sessionStatus >= 400) return json(options.sessionBody ?? {}, options.sessionStatus);
      return new Response(null, { status: 200, headers: { location: "https://upload.youtube.test/session/abc" } });
    }));
    return calls;
  }

  it("splits the text into a title and description", () => {
    expect(youtubeTitleAndDescription("First line\nMore words\n#tag")).toEqual({ title: "First line", description: "First line\nMore words\n#tag" });
    expect(youtubeTitleAndDescription("\n\n  Leading blanks  \nx").title).toBe("Leading blanks");
    const long = youtubeTitleAndDescription("x".repeat(150)).title;
    expect(long.length).toBe(100);
    expect(long.endsWith("…")).toBe(true);
  });

  it("opens a resumable session with the metadata, then uploads the file, as private by default", async () => {
    const calls = fakeYouTube();
    const result = await adapter.publishPost!(account, { text: "My launch video\nDetails here", media: [media("v.mp4", "video", "video/mp4", 4321)] });
    expect(result.externalPostId).toBe("vid123");
    expect(calls).toHaveLength(2);
    const [open, put] = calls;
    expect(open!.url).toBe("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status");
    expect(open!.headers.get("authorization")).toBe("Bearer YT_TOKEN");
    expect(open!.headers.get("x-upload-content-length")).toBe("4321");
    expect(open!.headers.get("x-upload-content-type")).toBe("video/mp4");
    expect(open!.body.snippet).toMatchObject({ title: "My launch video", description: "My launch video\nDetails here" });
    expect(open!.body.status).toMatchObject({ privacyStatus: "private", selfDeclaredMadeForKids: false });
    expect(put!.url).toBe("https://upload.youtube.test/session/abc");
    expect(put!.bytes).toBe(4321);
    expect(put!.headers.get("content-type")).toBe("video/mp4");
  });

  it("uses the privacy setting when the operator chooses one", async () => {
    vi.stubEnv("YOUTUBE_DEFAULT_PRIVACY", "unlisted");
    const calls = fakeYouTube();
    await adapter.publishPost!(account, { text: "T", media: [media("v.mp4", "video", "video/mp4")] });
    expect(calls[0]!.body.status.privacyStatus).toBe("unlisted");
    vi.unstubAllEnvs();
  });

  it("sets a photo as the video's thumbnail after the upload, and reports (not fails) a thumbnail problem", async () => {
    const calls = fakeYouTube({ putBody: { id: "vid123" } });
    const ok = await adapter.publishPost!(account, { text: "T", media: [media("v.mp4", "video", "video/mp4", 3000), media("t.jpg", "image", "image/jpeg", 800)] });
    expect(ok).toEqual({ externalPostId: "vid123" });
    const thumb = calls.find((c) => c.url.includes("thumbnails/set"))!;
    expect(thumb.url).toBe("https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=vid123");
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect(thumb.bytes).toBe(800);

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
      if (url.includes("thumbnails/set")) return json({ error: { code: 403, message: "The authenticated user doesn't have permissions to upload and set custom video thumbnails.", errors: [{ reason: "forbidden" }] } }, 403);
      if (init?.method === "PUT") return json({ id: "vid456" });
      return new Response(null, { status: 200, headers: { location: "https://upload.youtube.test/session/abc" } });
    }));
    const partial = await adapter.publishPost!(account, { text: "T", media: [media("v.mp4", "video", "video/mp4"), media("t.png", "image", "image/png")] });
    expect(partial.externalPostId).toBe("vid456");
    expect(partial.notice).toContain("thumbnail wasn't set");
    expect(partial.notice).toContain("verified channels");
  });

  it("refuses posts without exactly one video, empty titles and angle brackets before calling YouTube", async () => {
    const calls = fakeYouTube();
    await expect(adapter.publishPost!(account, { text: "T" })).rejects.toBeInstanceOf(OAuthError);
    await expect(adapter.publishPost!(account, { text: "T", media: [media("i.jpg", "image", "image/jpeg")] })).rejects.toBeInstanceOf(OAuthError);
    await expect(adapter.publishPost!(account, { text: "  ", media: [media("v.mp4", "video", "video/mp4")] })).rejects.toBeInstanceOf(OAuthError);
    const bad = await adapter.publishPost!(account, { text: "a <b> c", media: [media("v.mp4", "video", "video/mp4")] }).catch((e) => e);
    expect(bad.details.providerMessage).toContain("< or >");
    expect(calls).toHaveLength(0);
  });

  it("treats a quota error as a rate limit, not as a broken account", async () => {
    fakeYouTube({ sessionStatus: 403, sessionBody: { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } } });
    const error = await adapter.publishPost!(account, { text: "T", media: [media("v.mp4", "video", "video/mp4")] }).catch((e) => e);
    expect(error.code).toBe("rate_limited");
    expect(error.details.providerMessage).toContain("quotaExceeded");
  });

  it("maps an expired token to a dead token", async () => {
    fakeYouTube({ sessionStatus: 401, sessionBody: { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid Credentials" } } });
    const error = await adapter.publishPost!(account, { text: "T", media: [media("v.mp4", "video", "video/mp4")] }).catch((e) => e);
    expect(error.code).toBe("token_revoked");
  });

  it("reports a failed transfer", async () => {
    fakeYouTube({ putStatus: 400, putBody: { error: { code: 400, message: "Bad video", errors: [{ reason: "invalidVideo" }] } } });
    const error = await adapter.publishPost!(account, { text: "T", media: [media("v.mp4", "video", "video/mp4")] }).catch((e) => e);
    expect(error.code).toBe("publish_failed");
    expect(error.details.providerMessage).toContain("Bad video");
  });
});

beforeAll(() => { process.env.LOG_LEVEL = "silent"; });

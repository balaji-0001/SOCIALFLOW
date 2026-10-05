import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeGraph } from "../test/fake-graph";
import { installFakeLinkedIn } from "../test/fake-linkedin";
import { linkPreviewDeps, type HopResponse } from "./link-preview";
import { createFacebookAdapter } from "./oauth/providers/facebook";
import { createLinkedInAdapter } from "./oauth/providers/linkedin";
import { linkNoteForPlatform, parsePostLink } from "./post-extras";
import type { PublishMedia } from "./oauth/types";

// How a link attached to a post is published on each network, against faked endpoints. No real network is contacted.

const realDeps = { ...linkPreviewDeps };
afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(linkPreviewDeps, realDeps);
});

const link = { url: "https://example.com/story", title: "The story", description: "All about it", imageUrl: "https://cdn.example.com/card.png" };
const dir = mkdtempSync(join(tmpdir(), "socialflow-link-"));
const photoPath = join(dir, "a.jpg");
writeFileSync(photoPath, Buffer.alloc(200, 7));
const photo: PublishMedia = { kind: "image", mimeType: "image/jpeg", fileName: "a.jpg", sizeBytes: 200, filePath: photoPath, publicUrl: null };

describe("Facebook link posts", () => {
  const page = { externalAccountId: "1001", accessToken: "PAGE_TOKEN_1001", refreshToken: null, tokenExpiresAt: null, accountType: "facebook_page" };
  const adapter = createFacebookAdapter({ clientId: "test-app-id", clientSecret: "test-app-secret" });

  it("sends link= to /feed for a link with no media, with the text exactly as written", async () => {
    const { feedPosts } = installFakeGraph();
    await adapter.publishPost!(page, { text: "Read this https://example.com/story", link });
    expect(feedPosts).toHaveLength(1);
    expect(feedPosts[0]!.body.get("link")).toBe("https://example.com/story");
    expect(feedPosts[0]!.body.get("message")).toBe("Read this https://example.com/story");
    // The card's title and image come from the website's own Open Graph tags; Facebook ignores overrides.
    expect(feedPosts[0]!.body.has("name")).toBe(false);
    expect(feedPosts[0]!.body.has("picture")).toBe(false);
  });

  it("does not send link= when there is no link", async () => {
    const { feedPosts } = installFakeGraph();
    await adapter.publishPost!(page, { text: "Plain", link: null });
    expect(feedPosts[0]!.body.has("link")).toBe(false);
  });

  it("does not send link= when media is attached (the link stays in the text)", async () => {
    const { feedPosts, uploads } = installFakeGraph();
    await adapter.publishPost!(page, { text: "Photo https://example.com/story", media: [photo], link });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.fields.message ?? uploads[0]!.fields.caption).toBe("Photo https://example.com/story");
    expect(feedPosts.every((post) => !post.body.has("link"))).toBe(true);
    expect(uploads.every((upload) => !("link" in upload.fields))).toBe(true);
  });
});

describe("LinkedIn article posts", () => {
  const member = { externalAccountId: "li-member-123", accessToken: "LI_TOKEN", refreshToken: null, tokenExpiresAt: null, accountType: "linkedin_member" };
  const adapter = createLinkedInAdapter({ clientId: "id", clientSecret: "secret" });

  it("publishes an ARTICLE share with the link, title and description, and the text as written", async () => {
    const { ugcPosts } = installFakeLinkedIn();
    const result = await adapter.publishPost!(member, { text: "Worth a read", link: { ...link, imageUrl: null } });
    expect(result.externalPostId).toBe("urn:li:share:7000000000000000001");
    const content = ugcPosts[0]!.body.specificContent["com.linkedin.ugc.ShareContent"];
    expect(content.shareCommentary).toEqual({ text: "Worth a read" });
    expect(content.shareMediaCategory).toBe("ARTICLE");
    expect(content.media).toEqual([{ status: "READY", originalUrl: "https://example.com/story", title: { text: "The story" }, description: { text: "All about it" } }]);
    expect(ugcPosts[0]!.headers.get("x-restli-protocol-version")).toBe("2.0.0");
  });

  // Without LINKEDIN_API_VERSION configured, the classic UGC Posts API is all that's available, and it has no
  // request field a client can set to choose the card's image: LinkedIn fills "thumbnails" in from its own crawl
  // of originalUrl. A card image (link.imageUrl) is never uploaded or referenced, and no extra request is made.
  it("never uploads or references a thumbnail when LINKEDIN_API_VERSION isn't configured", async () => {
    const { ugcPosts } = installFakeLinkedIn();
    const requested: string[] = [];
    linkPreviewDeps.request = (async (url: URL) => { requested.push(url.toString()); return { status: 200, headers: {}, body: (async function* () {})(), destroy: vi.fn() }; }) as never;
    const result = await adapter.publishPost!(member, { text: "x", link });
    expect(requested).toEqual([]);
    expect(ugcPosts[0]!.body.specificContent["com.linkedin.ugc.ShareContent"].media[0]).not.toHaveProperty("thumbnails");
    expect(result.notice).toBeUndefined();
  });

  it("uses a normal image post, not an article, when media is attached", async () => {
    const { ugcPosts } = installFakeLinkedIn();
    // The fake has no upload endpoints, so this only checks that the link never turns a media post into an article.
    await adapter.publishPost!(member, { text: "x", media: [photo], link }).catch(() => undefined);
    expect(ugcPosts.every((post) => post.body.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory !== "ARTICLE")).toBe(true);
  });

  // With LINKEDIN_API_VERSION configured, the versioned Posts + Images APIs let a real thumbnail be attached.
  describe("with LINKEDIN_API_VERSION configured", () => {
    function stubImageHost(): HopResponse {
      return { status: 200, headers: { "content-type": "image/png" }, body: (async function* () { yield Buffer.from([137, 80, 78, 71]); })(), destroy: vi.fn() };
    }

    /**
     * The versioned Images + Posts endpoints, plus the classic /v2/ugcPosts endpoint so a test can also cover
     * publishPost falling back to it. `postStatus`/`postBody` let a test make /rest/posts itself fail.
     */
    function installVersionedLinkedIn(options: { postStatus?: number; postBody?: unknown } = {}) {
      const imageUploads: string[] = [];
      const posts: Array<{ headers: Headers; body: Record<string, any> }> = [];
      const ugcPosts: Array<{ headers: Headers; body: Record<string, any> }> = [];
      let registered = 0;
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
        const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
        if (url.hostname === "api.linkedin.com" && url.pathname === "/rest/images" && url.searchParams.get("action") === "initializeUpload") {
          registered += 1;
          return json({ value: { image: `urn:li:image:T${registered}`, uploadUrl: `https://upload.linkedin.test/img${registered}` } });
        }
        if (url.hostname === "upload.linkedin.test") { imageUploads.push(url.pathname); return new Response(null, { status: 201 }); }
        if (url.hostname === "api.linkedin.com" && url.pathname === "/rest/posts") {
          const body = JSON.parse(String(init!.body));
          posts.push({ headers: new Headers(init!.headers), body });
          if (options.postStatus) return json(options.postBody ?? { message: "no" }, options.postStatus);
          return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:9" } });
        }
        if (url.hostname === "api.linkedin.com" && url.pathname === "/v2/ugcPosts") {
          ugcPosts.push({ headers: new Headers(init!.headers), body: JSON.parse(String(init!.body)) });
          return json({ id: "urn:li:share:7000000000000000001" }, 201);
        }
        return json({ message: "Unknown path: " + url.pathname }, 404);
      }));
      return { imageUploads, posts, ugcPosts };
    }

    it("uploads the preview image through the Images API and sets it as the article's thumbnail", async () => {
      vi.stubEnv("LINKEDIN_API_VERSION", "202601");
      const { imageUploads, posts } = installVersionedLinkedIn();
      const requested: string[] = [];
      linkPreviewDeps.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
      linkPreviewDeps.request = (async (url: URL) => { requested.push(url.toString()); return stubImageHost(); }) as never;
      const result = await adapter.publishPost!(member, { text: "Worth a read", link });
      expect(requested).toEqual(["https://cdn.example.com/card.png"]);
      expect(imageUploads).toEqual(["/img1"]);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toMatchObject({
        author: "urn:li:person:li-member-123",
        commentary: "Worth a read",
        visibility: "PUBLIC",
        content: { article: { source: "https://example.com/story", title: "The story", description: "All about it", thumbnail: "urn:li:image:T1" } },
      });
      expect(posts[0]!.headers.get("linkedin-version")).toBe("202601");
      expect(result.externalPostId).toBe("urn:li:share:9");
      expect(result.notice).toBeUndefined();
    });

    it("still posts the article, without a thumbnail, when the preview image can't be fetched", async () => {
      vi.stubEnv("LINKEDIN_API_VERSION", "202601");
      const { imageUploads, posts } = installVersionedLinkedIn();
      linkPreviewDeps.lookup = async () => [{ address: "10.0.0.5", family: 4 }]; // private: refused by the SSRF-safe fetcher
      const result = await adapter.publishPost!(member, { text: "x", link });
      expect(imageUploads).toEqual([]);
      expect(posts[0]!.body.content.article).not.toHaveProperty("thumbnail");
      expect(result.externalPostId).toBe("urn:li:share:9");
      expect(result.notice).toMatch(/without its image/);
    });

    it("falls back to the classic article share when the versioned Posts API itself rejects the request", async () => {
      vi.stubEnv("LINKEDIN_API_VERSION", "202601");
      const { ugcPosts } = installVersionedLinkedIn({ postStatus: 422, postBody: { message: "bad request" } });
      linkPreviewDeps.lookup = async () => [{ address: "10.0.0.5", family: 4 }];
      const result = await adapter.publishPost!(member, { text: "x", link });
      expect(ugcPosts).toHaveLength(1);
      expect(ugcPosts[0]!.body.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory).toBe("ARTICLE");
      expect(result.externalPostId).toBe("urn:li:share:7000000000000000001");
      expect(result.notice).toMatch(/without its image/);
    });
  });
});

describe("networks that can't show a link card", () => {
  it("reports an honest note for Instagram and YouTube, and none for Facebook or LinkedIn", () => {
    expect(linkNoteForPlatform("instagram")).toMatch(/Instagram captions can't hold a clickable link/);
    expect(linkNoteForPlatform("youtube")).toMatch(/YouTube/);
    expect(linkNoteForPlatform("facebook")).toBeNull();
    expect(linkNoteForPlatform("linkedin")).toBeNull();
  });
});

describe("parsePostLink", () => {
  it("accepts a link with optional fields and null to remove", () => {
    expect(parsePostLink({ url: " https://a.test/x ", title: " T ", description: "", imageUrl: "https://a.test/i.png" })).toEqual({ ok: true, link: { url: "https://a.test/x", title: "T", description: null, imageUrl: "https://a.test/i.png" } });
    expect(parsePostLink({ url: "https://a.test" })).toEqual({ ok: true, link: { url: "https://a.test", title: null, description: null, imageUrl: null } });
    expect(parsePostLink(null)).toEqual({ ok: true, link: null });
  });

  it("rejects bad URLs and over-long fields", () => {
    for (const bad of [{ url: "ftp://a.test" }, { url: "javascript:alert(1)" }, { url: "" }, {}, "x", [], { url: "https://a.test", imageUrl: "data:image/png;base64,AA" }, { url: "https://a.test", title: "t".repeat(301) }, { url: "https://a.test", description: "d".repeat(1001) }, { url: `https://a.test/${"p".repeat(2048)}` }]) {
      expect(parsePostLink(bad).ok).toBe(false);
    }
  });
});

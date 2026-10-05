import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, mediaTable, postsTable, tableExists, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { instagramJpegFromUrl } from "./link-photo";
import { linkPreviewDeps, type HopResponse } from "./link-preview";
import { saveConnectedAccount } from "./oauth/accounts";

// A link's preview picture becoming an Instagram photo: converted to a JPEG in Instagram's limits, stored as media,
// and published from our own address. The picture is served by stubs; Instagram is faked. No real network.

const realDeps = { ...linkPreviewDeps };
const storageDir = mkdtempSync(join(tmpdir(), "socialflow-link-photo-"));
beforeEach(() => {
  vi.stubEnv("MEDIA_STORAGE_DIR", storageDir);
  vi.stubEnv("OAUTH_REDIRECT_BASE_URL", "https://socialflow.test");
  vi.stubEnv("INSTAGRAM_POLL_INTERVAL_MS", "1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.assign(linkPreviewDeps, realDeps);
});

/** Serves `bytes` as the picture for any URL, through the SSRF-safe fetcher's seams. */
function servePicture(bytes: Buffer, contentType = "image/png") {
  linkPreviewDeps.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  linkPreviewDeps.request = (async (): Promise<HopResponse> => ({ status: 200, headers: { "content-type": contentType, "content-length": String(bytes.length) }, body: (async function* () { yield bytes; })(), destroy: vi.fn() })) as never;
}

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 60, alpha: 1 } } }).png().toBuffer();

describe("instagramJpegFromUrl", () => {
  it("converts a PNG to a JPEG and keeps a shape Instagram already accepts", async () => {
    servePicture(await png(1200, 630)); // the usual Open Graph shape, 1.9:1
    const out = await instagramJpegFromUrl("https://cdn.example.com/card.png");
    expect(out.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 630]);
    expect(out.width / out.height).toBeLessThanOrEqual(1.91);
  });

  it("shrinks wide pictures to 1440 px and pads a too-wide one into 1.91:1 instead of cropping", async () => {
    servePicture(await png(3000, 1000)); // 3:1, wider than Instagram allows
    const out = await instagramJpegFromUrl("https://cdn.example.com/banner.png");
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(1440);
    expect((meta.width ?? 0) / (meta.height ?? 1)).toBeLessThanOrEqual(1.91);
    expect(meta.height).toBeGreaterThan(480); // 1440/3 = 480 would be the cropped height; padding makes it taller
  });

  it("pads a too-tall picture out to 4:5", async () => {
    servePicture(await png(400, 1000)); // 2:5, taller than Instagram allows
    const out = await instagramJpegFromUrl("https://cdn.example.com/tall.png");
    const meta = await sharp(out.bytes).metadata();
    expect((meta.width ?? 0) / (meta.height ?? 1)).toBeGreaterThanOrEqual(0.8 - 0.01);
    expect(meta.height).toBe(1000); // height kept; width padded
  });

  it("refuses a picture the SSRF-safe fetcher won't touch", async () => {
    linkPreviewDeps.lookup = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(instagramJpegFromUrl("https://intranet.example/x.png")).rejects.toThrow();
  });
});

const tablesExist = await tableExists("socialflow_posts").catch(() => false);
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();

describe.skipIf(!tablesExist)("publishing a link post to Instagram (database, test DB only)", () => {
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  /** graph.instagram.com, recording container creations; everything else 404s. */
  function fakeInstagram() {
    const posts: Array<{ path: string; params: Record<string, string> }> = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.hostname !== "graph.instagram.com") return json({ error: { message: `Unexpected host ${url.hostname}` } }, 404);
      if (init?.method === "POST") {
        const params = Object.fromEntries(new URLSearchParams(String(init.body)));
        posts.push({ path: url.pathname, params });
        return json({ id: url.pathname.endsWith("/media_publish") ? "ig-media-final" : `container${++n}` });
      }
      return json({ status_code: "FINISHED", id: url.pathname.slice(1) });
    }));
    return { posts };
  }

  it("converts the preview picture, stores it as media, and gives Instagram our own address for it", async () => {
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email: `link-photo-${Date.now()}@socialflow.test`, password: "correct horse battery staple" });
    expect(signup.status).toBe(201);
    createdUserIds.add(signup.body.user.id);
    createdWorkspaceIds.add(signup.body.workspace.id);
    const workspaceId = signup.body.workspace.id as string;
    const account = await saveConnectedAccount(db, workspaceId, "instagram", {
      externalAccountId: "ig-77", accountType: "instagram_business", displayName: "Shop", username: "shop", avatarUrl: null, accessToken: "IG_TOKEN",
      refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: ["instagram_business_basic", "instagram_business_content_publish"], metadata: {}, selectable: true, warnings: [],
    }, "ig-user");

    servePicture(await png(1200, 630));
    const { posts } = fakeInstagram();
    const draft = await agent.post("/api/posts").send({
      content: "Read this https://example.com/story",
      connectedAccountIds: [account.id],
      link: { url: "https://example.com/story", title: "The story", description: "d", imageUrl: "https://cdn.example.com/card.png" },
    });
    expect(draft.status).toBe(201);

    const res = await agent.post(`/api/posts/${draft.body.id}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("published");
    expect(res.body.targets[0].status).toBe("published");
    expect(res.body.targets[0].errorMessage).toMatch(/preview picture was posted as the photo/);

    // Instagram was pointed at a JPEG served from our own public media URL, not at the website's PNG.
    const create = posts.find((p) => p.path === "/ig-77/media")!;
    expect(create.params.caption).toBe("Read this https://example.com/story");
    expect(create.params.image_url).toMatch(/^https:\/\/socialflow\.test\/api\/media\/public\//);
    expect(create.params.image_url).not.toContain("cdn.example.com");

    const [stored] = await db.select().from(mediaTable).where(eq(mediaTable.workspaceId, workspaceId));
    expect(stored).toMatchObject({ kind: "image", mimeType: "image/jpeg", width: 1200, height: 630 });
    expect(stored!.originalName).toContain("preview.jpg");
    // The photo is not attached to the post, so a Facebook or LinkedIn target of the same post keeps its link card.
    const [post] = await db.select().from(postsTable).where(eq(postsTable.id, draft.body.id));
    expect(post!.linkUrl).toBe("https://example.com/story");
    const attached = await db.execute(sql`select 1 from socialflow_post_media where post_id = ${draft.body.id}`);
    expect(attached.rows).toHaveLength(0);
  });

  it("falls back to handing Instagram the picture's URL when the picture can't be converted", async () => {
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email: `link-photo-b-${Date.now()}@socialflow.test`, password: "correct horse battery staple" });
    createdUserIds.add(signup.body.user.id);
    createdWorkspaceIds.add(signup.body.workspace.id);
    const account = await saveConnectedAccount(db, signup.body.workspace.id, "instagram", {
      externalAccountId: "ig-78", accountType: "instagram_business", displayName: "Shop", username: "shop", avatarUrl: null, accessToken: "IG_TOKEN",
      refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: ["instagram_business_basic", "instagram_business_content_publish"], metadata: {}, selectable: true, warnings: [],
    }, "ig-user");

    linkPreviewDeps.lookup = async () => [{ address: "10.0.0.5", family: 4 }]; // our fetcher refuses it; Instagram may still manage
    const { posts } = fakeInstagram();
    const draft = await agent.post("/api/posts").send({ content: "x https://example.com/s", connectedAccountIds: [account.id], link: { url: "https://example.com/s", title: null, description: null, imageUrl: "https://cdn.example.com/card.png" } });
    const res = await agent.post(`/api/posts/${draft.body.id}/publish`);
    expect(res.body.status).toBe("published");
    expect(posts.find((p) => p.path === "/ig-78/media")!.params.image_url).toBe("https://cdn.example.com/card.png");
  });
});

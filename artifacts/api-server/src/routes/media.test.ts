import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db, mediaTable, postsTable, postTargetsTable, tableExists, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { signedPublicMediaUrl, sniffMedia, storedFilePath, sweepOrphanMedia } from "../lib/media";
import { runPublishCycle } from "../lib/publisher";
import { installFakeGraph } from "../test/fake-graph";
import { saveConnectedAccount } from "../lib/oauth/accounts";

const tablesExist = await tableExists("socialflow_media").catch(() => false);

// The orphan sweep and the scheduler act on every row in the database, so tests that call them only run
// against a *_test database (see publisher.test.ts for the reasoning).
const isolatedTestDb = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", "").endsWith("_test");
  } catch {
    return false;
  }
})();

type Agent = ReturnType<typeof request.agent>;
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function newUser(): Promise<{ agent: Agent; workspaceId: string }> {
  const agent = request.agent(app);
  const email = `media-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, workspaceId: res.body.workspace.id };
}

// A real 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0", "latin1"), Buffer.alloc(64, 1)]);
const MP4 = (size: number) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42", "latin1"), Buffer.alloc(size - 12, 7)]);
const WEBM = (size: number) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(size - 4, 9)]);
const pad = (head: Buffer, size: number) => Buffer.concat([head, Buffer.alloc(size - head.length, 0)]);

const upload = (agent: Agent, body: Buffer, name = "photo.png", headers: Record<string, string> = {}) => {
  let req = agent.post("/api/media").set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name));
  for (const [key, value] of Object.entries(headers)) req = req.set(key, value);
  return req.send(body);
};
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

describe.skipIf(!tablesExist)("Media uploads (database)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("identifies file types from their bytes", () => {
    expect(sniffMedia(PNG)?.mime).toBe("image/png");
    expect(sniffMedia(JPEG)?.mime).toBe("image/jpeg");
    expect(sniffMedia(Buffer.from("GIF89a" + "x".repeat(20), "latin1"))?.mime).toBe("image/gif");
    expect(sniffMedia(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]))?.mime).toBe("image/webp");
    expect(sniffMedia(MP4(64))?.mime).toBe("video/mp4");
    expect(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  ", "latin1"), Buffer.alloc(16)]))?.mime).toBe("video/quicktime");
    expect(sniffMedia(WEBM(64))?.mime).toBe("video/webm");
    expect(sniffMedia(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).toBeNull();
    expect(sniffMedia(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(sniffMedia(Buffer.from("MZ" + "\0".repeat(30), "latin1"))).toBeNull();
  });

  it("requires sign-in for every media route", async () => {
    expect((await request(app).get("/api/media/config")).status).toBe(401);
    expect((await request(app).post("/api/media").send(PNG)).status).toBe(401);
    expect((await request(app).get("/api/media/00000000-0000-4000-8000-000000000000/file")).status).toBe(401);
    expect((await request(app).delete("/api/media/00000000-0000-4000-8000-000000000000")).status).toBe(401);
  });

  it("reports the limits and allowed types the uploader validates against", async () => {
    const { agent } = await newUser();
    const res = await agent.get("/api/media/config");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ maxImageBytes: 300000, maxVideoBytes: 1000000, maxFilesPerPost: 4 });
    expect(res.body.allowedTypes.map((t: { mime: string }) => t.mime)).toEqual(expect.arrayContaining(["image/png", "image/jpeg", "video/mp4", "video/webm"]));
  });

  it("stores an image, records display metadata, and serves the exact bytes back", async () => {
    const { agent } = await newUser();
    const res = await upload(agent, PNG, "My Photo.png", { "X-Media-Width": "1", "X-Media-Height": "1" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "image", mimeType: "image/png", fileName: "My Photo.png", sizeBytes: PNG.length, width: 1, height: 1, durationMs: null });
    expect(res.body.url).toBe(`/api/media/${res.body.id}/file`);

    const file = await agent.get(res.body.url).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("image/png");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
  });

  it("decides the type from the bytes, ignoring the filename and Content-Type", async () => {
    const { agent } = await newUser();
    const html = await agent.post("/api/media").set("Content-Type", "image/png").set("X-File-Name", "innocent.png").send(pad(Buffer.from("<html><script>alert(1)</script></html>"), 200));
    expect(html.status).toBe(415);
    expect(html.body.error).toBe("unsupported_type");
    const svg = await upload(agent, pad(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"), 200), "logo.svg");
    expect(svg.status).toBe(415);
    const exe = await upload(agent, pad(Buffer.from("MZ"), 200), "setup.png");
    expect(exe.status).toBe(415);
    // A real PNG is accepted even when it is named like something else.
    const renamed = await upload(agent, PNG, "notes.txt");
    expect(renamed.status).toBe(201);
    expect(renamed.body.mimeType).toBe("image/png");
  });

  it("rejects empty and truncated files with a clear message", async () => {
    const { agent } = await newUser();
    const empty = await upload(agent, Buffer.alloc(0));
    expect(empty.status).toBe(400);
    expect(empty.body.message).toMatch(/empty/i);
    const tiny = await upload(agent, Buffer.from([0x89, 0x50, 0x4e]));
    expect(tiny.status).toBe(400);
  });

  it("enforces separate size limits for images and videos", async () => {
    const { agent } = await newUser();
    const bigImage = await upload(agent, pad(PNG, 350_000));
    expect(bigImage.status).toBe(413);
    expect(bigImage.body).toMatchObject({ error: "file_too_large" });
    expect(bigImage.body.message).toContain("Images can be up to");
    // The same size is fine as a video (limit 1,000,000).
    const okVideo = await upload(agent, MP4(350_000), "clip.mp4");
    expect(okVideo.status).toBe(201);
    const bigVideo = await upload(agent, MP4(1_100_000), "long.mp4");
    expect(bigVideo.status).toBe(413);
    expect(bigVideo.body.message).toMatch(/videos up to/i);
  });

  it("supports Range requests so videos can seek", async () => {
    const { agent } = await newUser();
    const clip = await upload(agent, MP4(200_000), "clip.mp4", { "X-Media-Duration-Ms": "4500", "X-Media-Width": "1280", "X-Media-Height": "720" });
    expect(clip.body).toMatchObject({ kind: "video", mimeType: "video/mp4", durationMs: 4500, width: 1280, height: 720 });
    const part = await agent.get(clip.body.url).set("Range", "bytes=1000-1999").buffer(true).parse((r, cb) => { let n = 0; r.on("data", (c: Buffer) => { n += c.length; }); r.on("end", () => cb(null, n as unknown as Buffer)); });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 1000-1999/200000");
    expect(part.body as unknown as number).toBe(1000);
  });

  it("ignores nonsense display metadata instead of trusting it", async () => {
    const { agent } = await newUser();
    const res = await upload(agent, PNG, "a.png", { "X-Media-Width": "99999999", "X-Media-Height": "-5", "X-Media-Duration-Ms": "abc" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ width: null, height: null, durationMs: null });
  });

  it("neutralizes path tricks in filenames and never uses them for storage", async () => {
    const { agent } = await newUser();
    const res = await upload(agent, PNG, "../../etc/passwd.png");
    expect(res.status).toBe(201);
    expect(res.body.fileName).not.toContain("/");
    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, res.body.id));
    expect(row!.storageKey).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
    expect(storedFilePath("../../../etc/passwd")).toBeNull();
    expect(storedFilePath(row!.storageKey)).not.toBeNull();
  });

  it("keeps each workspace's files private", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const file = await upload(alice.agent, PNG);
    expect((await bob.agent.get(file.body.url)).status).toBe(404);
    expect((await bob.agent.delete(`/api/media/${file.body.id}`)).status).toBe(404);
    expect((await alice.agent.get(file.body.url)).status).toBe(200);
    const post = await bob.agent.post("/api/posts").send({ content: "steal", connectedAccountIds: [], mediaIds: [file.body.id] });
    expect(post.status).toBe(400);
  });

  it("deletes an unattached upload and its file", async () => {
    const { agent } = await newUser();
    const file = await upload(agent, PNG);
    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, file.body.id));
    const onDisk = storedFilePath(row!.storageKey)!;
    expect(existsSync(onDisk)).toBe(true);
    expect((await agent.delete(`/api/media/${file.body.id}`)).status).toBe(204);
    expect(existsSync(onDisk)).toBe(false);
    expect((await agent.get(file.body.url)).status).toBe(404);
  });

  it("attaches media to a post in the chosen order, and reorders it", async () => {
    const { agent } = await newUser();
    const a = await upload(agent, PNG, "a.png");
    const b = await upload(agent, JPEG, "b.jpg");
    const c = await upload(agent, MP4(2000), "c.mp4");
    const created = await agent.post("/api/posts").send({ content: "Gallery", connectedAccountIds: [], mediaIds: [c.body.id, a.body.id, b.body.id] });
    expect(created.status).toBe(201);
    expect(created.body.media.map((m: { fileName: string }) => m.fileName)).toEqual(["c.mp4", "a.png", "b.jpg"]);

    const reordered = await agent.patch(`/api/posts/${created.body.id}`).send({ mediaIds: [b.body.id, c.body.id, a.body.id] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.media.map((m: { fileName: string }) => m.fileName)).toEqual(["b.jpg", "c.mp4", "a.png"]);
    expect((await agent.get(`/api/posts/${created.body.id}`)).body.media.map((m: { fileName: string }) => m.fileName)).toEqual(["b.jpg", "c.mp4", "a.png"]);

    const untouched = await agent.patch(`/api/posts/${created.body.id}`).send({ content: "Gallery (edited)" });
    expect(untouched.body.media).toHaveLength(3);
  });

  it("deletes files when they are removed from a post or the post is deleted", async () => {
    const { agent } = await newUser();
    const a = await upload(agent, PNG, "a.png");
    const b = await upload(agent, JPEG, "b.jpg");
    const post = await agent.post("/api/posts").send({ content: "Two files", connectedAccountIds: [], mediaIds: [a.body.id, b.body.id] });

    const removed = await agent.patch(`/api/posts/${post.body.id}`).send({ mediaIds: [b.body.id] });
    expect(removed.body.media).toHaveLength(1);
    expect((await agent.get(a.body.url)).status).toBe(404);
    expect((await agent.get(b.body.url)).status).toBe(200);

    expect((await agent.delete(`/api/media/${b.body.id}`)).status).toBe(400);
    expect((await agent.delete(`/api/posts/${post.body.id}`)).status).toBe(204);
    expect((await agent.get(b.body.url)).status).toBe(404);
  });

  it("refuses too many files, duplicates, unknown ids, and files already used by another post", async () => {
    const { agent } = await newUser();
    const files = [];
    for (let i = 0; i < 5; i++) files.push((await upload(agent, PNG, `f${i}.png`)).body.id as string);
    const tooMany = await agent.post("/api/posts").send({ content: "x", connectedAccountIds: [], mediaIds: files });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toContain("up to 4 files");
    expect((await agent.post("/api/posts").send({ content: "x", connectedAccountIds: [], mediaIds: [files[0], files[0]] })).status).toBe(400);
    expect((await agent.post("/api/posts").send({ content: "x", connectedAccountIds: [], mediaIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    const first = await agent.post("/api/posts").send({ content: "one", connectedAccountIds: [], mediaIds: [files[0]] });
    expect(first.status).toBe(201);
    const reuse = await agent.post("/api/posts").send({ content: "two", connectedAccountIds: [], mediaIds: [files[0]] });
    expect(reuse.status).toBe(400);
    expect(reuse.body.message).toContain("another post");
  });

  it("serves a signed public link to exactly one file, without a session, and refuses anything else", async () => {
    const { agent } = await newUser();
    const one = await upload(agent, PNG, "one.png");
    const two = await upload(agent, PNG, "two.png");
    const link = new URL(signedPublicMediaUrl(one.body.id)!);
    const path = link.pathname + link.search;
    const anonymous = await request(app).get(path);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(anonymous.body).equals(PNG)).toBe(true);
    expect((await request(app).get(`/api/media/${one.body.id}/file`)).status).toBe(401);
    expect((await request(app).get(path.replace(one.body.id, two.body.id))).status).toBe(404);
    expect((await request(app).get(link.pathname)).status).toBe(404);
    expect((await request(app).get(path.replace(/s=./, "s=X"))).status).toBe(404);
  });

  it("stops accepting uploads once the workspace storage quota is reached", async () => {
    const { agent } = await newUser();
    expect((await upload(agent, MP4(900_000), "a.mp4")).status).toBe(201);
    const over = await upload(agent, MP4(700_000), "b.mp4");
    expect(over.status).toBe(413);
    expect(over.body.error).toBe("quota_exceeded");
    // Freeing space makes room again.
    const list = await db.select().from(mediaTable).where(eq(mediaTable.originalName, "a.mp4"));
    await agent.delete(`/api/media/${list[list.length - 1]!.id}`);
    expect((await upload(agent, MP4(700_000), "b.mp4")).status).toBe(201);
  });

  it("applies each network's media rules when scheduling or publishing, and accepts what the network can take", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await saveConnectedAccount(db, workspaceId, "facebook", {
      externalAccountId: "1001", accountType: "facebook_page", displayName: "Acme", username: null, avatarUrl: null, accessToken: "PAGE_TOKEN_1001",
      refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], metadata: {}, selectable: true, warnings: [],
    }, "u");
    const ig = await saveConnectedAccount(db, workspaceId, "instagram", {
      externalAccountId: "ig-1", accountType: "instagram_business", displayName: "acme", username: "acme", avatarUrl: null, accessToken: "IG_TOKEN",
      refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], metadata: {}, selectable: true, warnings: [],
    }, "u");
    const png = await upload(agent, PNG, "a.png");
    const mp4 = await upload(agent, MP4(2000), "a.mp4");

    // A Facebook Page can take a photo: scheduling with it is accepted.
    const scheduled = await agent.post("/api/posts").send({ content: "With image", connectedAccountIds: [account.id], scheduledAt: inAnHour(), mediaIds: [png.body.id] });
    expect(scheduled.status).toBe(201);
    expect(scheduled.body.status).toBe("scheduled");
    // Instagram takes JPEG only, so a PNG is refused with the reason.
    const png2 = await upload(agent, PNG, "b.png");
    const igPng2 = await agent.post("/api/posts").send({ content: "x", connectedAccountIds: [ig.id], scheduledAt: inAnHour(), mediaIds: [png2.body.id] });
    expect(igPng2.status).toBe(400);
    expect(igPng2.body.message).toContain("JPG images only");
    // Facebook takes photos or one video, not both.
    const mixed = await agent.post("/api/posts").send({ content: "x", connectedAccountIds: [account.id], scheduledAt: inAnHour(), mediaIds: [png2.body.id, mp4.body.id] });
    expect(mixed.status).toBe(400);
    expect(mixed.body.message).toContain("photos or one video");
    // Drafts are never blocked by network rules.
    const draft = await agent.post("/api/posts").send({ content: "x", connectedAccountIds: [ig.id], mediaIds: [png2.body.id, mp4.body.id] });
    expect(draft.status).toBe(201);
    const patch = await agent.patch(`/api/posts/${draft.body.id}`).send({ scheduledAt: inAnHour() });
    expect(patch.status).toBe(400);
    // Removing the file the network can't take fixes it (Instagram: a single MP4 is a Reel).
    const fixed = await agent.patch(`/api/posts/${draft.body.id}`).send({ mediaIds: [mp4.body.id], scheduledAt: inAnHour() });
    expect(fixed.status).toBe(200);
    expect(fixed.body.status).toBe("scheduled");
  });

  it("publishes a post's photo and video to a Facebook Page as real uploads", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await saveConnectedAccount(db, workspaceId, "facebook", {
      externalAccountId: "1001", accountType: "facebook_page", displayName: "Acme", username: null, avatarUrl: null, accessToken: "PAGE_TOKEN_1001",
      refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], metadata: {}, selectable: true, warnings: [],
    }, "u");
    const photo = await upload(agent, PNG, "launch.png");
    const { uploads } = installFakeGraph();
    const draft = await agent.post("/api/posts").send({ content: "Launch day", connectedAccountIds: [account.id], mediaIds: [photo.body.id] });
    const sent = await agent.post(`/api/posts/${draft.body.id}/publish`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("published");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.edge).toBe("photos");
    expect(uploads[0]!.fields.caption).toBe("Launch day");
    expect(uploads[0]!.fileName).toBe("launch.png");
    expect(uploads[0]!.bytes.equals(PNG)).toBe(true);
    expect(sent.body.targets[0].postUrl).toContain("1001_");

    const clip = await upload(agent, MP4(3000), "clip.mp4");
    const videoPost = await agent.post("/api/posts").send({ content: "Watch this", connectedAccountIds: [account.id], mediaIds: [clip.body.id] });
    const sentVideo = await agent.post(`/api/posts/${videoPost.body.id}/publish`);
    expect(sentVideo.body.status).toBe("published");
    expect(uploads[1]!.edge).toBe("videos");
    expect(uploads[1]!.fields.description).toBe("Watch this");
    expect(uploads[1]!.bytes.length).toBe(3000);
  });
});

describe.skipIf(!tablesExist || !isolatedTestDb)("Media cleanup and publishing guard (test DB only)", () => {
  it("sweeps uploads that were never attached, and only those", async () => {
    const { agent } = await newUser();
    const orphan = await upload(agent, PNG, "orphan.png");
    const kept = await upload(agent, PNG, "kept.png");
    await agent.post("/api/posts").send({ content: "keeps one", connectedAccountIds: [], mediaIds: [kept.body.id] });
    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, orphan.body.id));
    const onDisk = storedFilePath(row!.storageKey)!;

    const removedNow = await sweepOrphanMedia();
    expect((await agent.get(orphan.body.url)).status).toBe(200); // too new to be swept
    expect(removedNow).toBeGreaterThanOrEqual(0);

    const removed = await sweepOrphanMedia(new Date(Date.now() + 25 * 3600_000));
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(onDisk)).toBe(false);
    expect((await agent.get(orphan.body.url)).status).toBe(404);
    expect((await agent.get(kept.body.url)).status).toBe(200);
  });

  it("the scheduler publishes a due post with its media, and never sends the text alone when a file is gone", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await saveConnectedAccount(db, workspaceId, "facebook", {
      externalAccountId: "1001", accountType: "facebook_page", displayName: "Acme", username: null, avatarUrl: null, accessToken: "PAGE_TOKEN_1001",
      refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], metadata: {}, selectable: true, warnings: [],
    }, "u");
    const file = await upload(agent, PNG);
    const draft = await agent.post("/api/posts").send({ content: "Has an image", connectedAccountIds: [account.id], mediaIds: [file.body.id] });
    // Force the state the API refuses to create: a due, scheduled post with media.
    await db.update(postsTable).set({ status: "scheduled", scheduledAt: new Date(Date.now() - 60_000) }).where(eq(postsTable.id, draft.body.id));
    await db.update(postTargetsTable).set({ status: "scheduled" }).where(eq(postTargetsTable.postId, draft.body.id));
    const { uploads, fetchMock } = installFakeGraph();

    // The file vanishes from disk before the post goes out: the post fails instead of going out without it.
    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, file.body.id));
    const onDisk = storedFilePath(row!.storageKey)!;
    const kept = readFileSync(onDisk);
    rmSync(onDisk);
    await runPublishCycle();
    expect(fetchMock).not.toHaveBeenCalled();
    let [post] = await db.select().from(postsTable).where(and(eq(postsTable.id, draft.body.id)));
    expect(post!.status).toBe("failed");
    const [target] = await db.select().from(postTargetsTable).where(eq(postTargetsTable.postId, draft.body.id));
    expect(target!.errorMessage).toContain("is no longer available");

    // Restored, it publishes with the photo.
    writeFileSync(onDisk, kept);
    await db.update(postsTable).set({ status: "scheduled", scheduledAt: new Date(Date.now() - 60_000) }).where(eq(postsTable.id, draft.body.id));
    await db.update(postTargetsTable).set({ status: "scheduled" }).where(eq(postTargetsTable.postId, draft.body.id));
    await runPublishCycle();
    [post] = await db.select().from(postsTable).where(and(eq(postsTable.id, draft.body.id)));
    expect(post!.status).toBe("published");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.edge).toBe("photos");
  });
});

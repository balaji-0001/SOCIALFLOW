import { inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, tableExists, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { clearLinkPreviewCache, linkPreviewDeps, type HopResponse } from "../lib/link-preview";

const tablesExist = await tableExists("socialflow_posts").catch(() => false);

const realDeps = { ...linkPreviewDeps };
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();

function page(body: string, status = 200, headers: Record<string, string> = { "content-type": "text/html" }): HopResponse {
  return { status, headers, body: (async function* () { yield Buffer.from(body); })(), destroy: vi.fn() };
}

async function signedIn() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email: `link-test-${Date.now()}-${Math.random().toString(36).slice(2)}@socialflow.test`, password: "correct horse battery staple" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return agent;
}

describe.skipIf(!tablesExist)("GET /api/link-preview", () => {
  beforeEach(() => {
    clearLinkPreviewCache();
    linkPreviewDeps.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  });
  afterEach(() => Object.assign(linkPreviewDeps, realDeps));
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("requires sign-in", async () => {
    expect((await request(app).get("/api/link-preview").query({ url: "https://example.com" })).status).toBe(401);
  });

  it("returns the preview", async () => {
    linkPreviewDeps.request = async () => page(`<meta property="og:title" content="Hi"><meta property="og:image" content="/i.png"><meta property="og:site_name" content="Ex">`);
    const agent = await signedIn();
    const res = await agent.get("/api/link-preview").query({ url: "https://example.com/p" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: "https://example.com/p", title: "Hi", description: null, imageUrl: "https://example.com/i.png", siteName: "Ex" });
    expect(typeof res.body.fetchedAt).toBe("string");
  });

  it("maps errors: 400 invalid_url, 422 no_preview, 502 fetch_failed", async () => {
    const agent = await signedIn();
    const requestSpy = vi.fn(async () => page("<html></html>"));
    linkPreviewDeps.request = requestSpy;
    const bad = await agent.get("/api/link-preview").query({ url: "http://127.0.0.1/" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_url");
    expect((await agent.get("/api/link-preview")).status).toBe(400);
    expect((await agent.get("/api/link-preview").query({ url: "file:///etc/passwd" })).status).toBe(400);
    expect(requestSpy).not.toHaveBeenCalled();
    const empty = await agent.get("/api/link-preview").query({ url: "https://example.com/empty" });
    expect(empty.status).toBe(422);
    expect(empty.body.error).toBe("no_preview");
    linkPreviewDeps.request = async () => page("x", 500);
    const failed = await agent.get("/api/link-preview").query({ url: "https://example.com/down" });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("fetch_failed");
  });
});

describe.skipIf(!tablesExist)("GET /api/link-preview/image", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  beforeEach(() => {
    linkPreviewDeps.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  });
  afterEach(() => Object.assign(linkPreviewDeps, realDeps));

  it("requires sign-in", async () => {
    expect((await request(app).get("/api/link-preview/image").query({ url: "https://cdn.example.com/a.png" })).status).toBe(401);
  });

  it("serves the picture from our own origin, as an image only, and caches it", async () => {
    const agent = await signedIn();
    const spy = vi.fn(async () => page(PNG as unknown as string, 200, { "content-type": "image/png" }));
    linkPreviewDeps.request = spy as never;
    const url = `https://cdn.example.com/card-${Date.now()}.png`;
    const res = await agent.get("/api/link-preview/image").query({ url }).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
    await agent.get("/api/link-preview/image").query({ url });
    expect(spy).toHaveBeenCalledTimes(1); // second request came from the cache
  });

  it("refuses non-images, private addresses and non-http links", async () => {
    const agent = await signedIn();
    linkPreviewDeps.request = (async () => page("<svg onload=alert(1)>", 200, { "content-type": "image/svg+xml" })) as never;
    expect((await agent.get("/api/link-preview/image").query({ url: `https://cdn.example.com/x-${Date.now()}.svg` })).status).toBe(502);
    linkPreviewDeps.lookup = async () => [{ address: "169.254.169.254", family: 4 }];
    expect((await agent.get("/api/link-preview/image").query({ url: "http://metadata.example/latest" })).status).toBe(400);
    expect((await agent.get("/api/link-preview/image").query({ url: "file:///etc/passwd" })).status).toBe(400);
    expect((await agent.get("/api/link-preview/image")).status).toBe(400);
  });
});

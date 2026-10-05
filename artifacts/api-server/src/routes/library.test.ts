import { eq, inArray } from "drizzle-orm";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, mediaTable, usersTable, workspaceMembersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { placeholdersOf, renderTemplate } from "../lib/library";
import libraryRouter from "./library";

// Content library. The library router is mounted on a small app here so the suite runs before it is registered in
// routes/index.ts; sessions come from the real sign-up endpoint and are the real cookies.

const libApp = express();
libApp.use(cookieParser(process.env.SESSION_SECRET));
libApp.use(express.json());
libApp.use("/api", libraryRouter);

const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function signup(role?: "viewer" | "editor") {
  const email = `library-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await request(app).post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  if (role) await db.update(workspaceMembersTable).set({ role }).where(eq(workspaceMembersTable.userId, res.body.user.id));
  const cookie = (res.headers["set-cookie"] as unknown as string[]).map((c) => c.split(";")[0]).join("; ");
  const call = (method: "get" | "post" | "patch" | "delete", path: string) => request(libApp)[method](`/api${path}`).set("Cookie", cookie);
  return { call, cookie, workspaceId: res.body.workspace.id as string, userId: res.body.user.id as string };
}

async function newMedia(workspaceId: string, userId: string, name = "photo.png") {
  const [row] = await db.insert(mediaTable).values({ workspaceId, uploadedByUserId: userId, kind: "image", mimeType: "image/png", originalName: name, sizeBytes: 68, storageKey: `library-test-${Math.random().toString(36).slice(2)}.png` }).returning();
  return row!;
}

beforeAll(async () => {
});

afterAll(async () => {
  if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
  if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
});

describe("template helpers", () => {
  it("finds and fills placeholders, and reports missing ones without inventing values", () => {
    expect(placeholdersOf("Hi {{ name }}, {{name}} at {{shop}}")).toEqual(["name", "shop"]);
    expect(renderTemplate("Hi {{name}}!", { name: "Sam" })).toEqual({ text: "Hi Sam!", missing: [] });
    expect(renderTemplate("Hi {{name}} {{shop}}", { name: "Sam" }).missing).toEqual(["shop"]);
  });
});

describe("content library API", () => {
  it("requires sign-in", async () => {
    expect((await request(libApp).get("/api/library")).status).toBe(401);
  });

  it("creates, lists, searches, updates and deletes text items", async () => {
    const a = await signup();
    const created = await a.call("post", "/library").send({ kind: "caption", title: "Launch day", body: "We are live! #launch", labels: ["Launch", "launch", "promo"] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: "caption", useCount: 0, favorite: false, labels: ["Launch", "promo"], media: null });
    await a.call("post", "/library").send({ kind: "snippet", title: "Hashtags", body: "#a #b" });

    const search = await a.call("get", "/library?q=LIVE");
    expect(search.body.items.map((i: { title: string }) => i.title)).toEqual(["Launch day"]);
    expect((await a.call("get", "/library?q=%25")).body.items).toHaveLength(0);
    expect((await a.call("get", "/library?kind=snippet")).body.items).toHaveLength(1);
    expect((await a.call("get", "/library?label=PROMO")).body.items).toHaveLength(1);
    expect((await a.call("get", "/library?sort=name")).body.items[0].title).toBe("Hashtags");

    const patched = await a.call("patch", `/library/${created.body.id}`).send({ favorite: true, title: "Launch!" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ favorite: true, title: "Launch!" });
    expect((await a.call("get", "/library?favorite=true")).body.items).toHaveLength(1);

    expect((await a.call("delete", `/library/${created.body.id}`)).status).toBe(204);
    expect((await a.call("delete", `/library/${created.body.id}`)).status).toBe(404);
  });

  it("paginates with a cursor", async () => {
    const a = await signup();
    for (let i = 0; i < 3; i++) await a.call("post", "/library").send({ kind: "caption", title: `Item ${i}`, body: "x" });
    const p1 = await a.call("get", "/library?limit=2&sort=name");
    expect(p1.body.items.map((i: { title: string }) => i.title)).toEqual(["Item 0", "Item 1"]);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await a.call("get", `/library?limit=2&sort=name&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((i: { title: string }) => i.title)).toEqual(["Item 2"]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await a.call("get", "/library?cursor=garbage")).status).toBe(400);
  });

  it("validates input and enforces size limits", async () => {
    const a = await signup();
    expect((await a.call("post", "/library").send({ kind: "caption", title: "x".repeat(201), body: "b" })).status).toBe(400);
    expect((await a.call("post", "/library").send({ kind: "caption", title: "t", body: "x".repeat(20001) })).status).toBe(400);
    expect((await a.call("post", "/library").send({ kind: "caption", title: "t" })).status).toBe(400);
    expect((await a.call("post", "/library").send({ kind: "nope", title: "t", body: "b" })).status).toBe(400);
    expect((await a.call("post", "/library").send({ kind: "media", title: "t" })).status).toBe(400);
    expect((await a.call("get", "/library?sort=bogus")).status).toBe(400);
  });

  it("records use and returns the item", async () => {
    const a = await signup();
    const item = (await a.call("post", "/library").send({ kind: "caption", title: "Reuse me", body: "hello" })).body;
    const used = await a.call("post", `/library/${item.id}/use`);
    expect(used.status).toBe(200);
    expect(used.body).toMatchObject({ id: item.id, body: "hello", useCount: 1 });
    expect(used.body.lastUsedAt).toBeTruthy();
    expect((await a.call("get", "/library?sort=used")).body.items[0].id).toBe(item.id);
  });

  it("renders templates and lists missing variables", async () => {
    const a = await signup();
    const t = (await a.call("post", "/library").send({ kind: "template", title: "Sale", body: "{{product}} is {{discount}} off" })).body;
    expect(t.placeholders).toEqual(["product", "discount"]);
    const ok = await a.call("post", `/library/${t.id}/render`).send({ variables: { product: "Tea", discount: "20%" } });
    expect(ok.body.text).toBe("Tea is 20% off");
    const missing = await a.call("post", `/library/${t.id}/render`).send({ variables: { product: "Tea" } });
    expect(missing.status).toBe(400);
    expect(missing.body.missing).toEqual(["discount"]);
    const cap = (await a.call("post", "/library").send({ kind: "caption", title: "c", body: "plain" })).body;
    expect((await a.call("post", `/library/${cap.id}/render`).send({ variables: {} })).status).toBe(400);
  });

  it("references existing media without copying or deleting it", async () => {
    const a = await signup();
    const media = await newMedia(a.workspaceId, a.userId);
    const saved = await a.call("post", `/library/from-media/${media.id}`);
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ kind: "media", mediaId: media.id, title: "photo.png" });
    expect(saved.body.media.id).toBe(media.id);
    const again = await a.call("post", `/library/from-media/${media.id}`);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(saved.body.id);

    expect((await a.call("delete", `/library/${saved.body.id}`)).status).toBe(204);
    const [still] = await db.select().from(mediaTable).where(eq(mediaTable.id, media.id));
    expect(still).toBeTruthy();

    const viaPost = await a.call("post", "/library").send({ kind: "media", title: "Direct", mediaId: media.id });
    expect(viaPost.status).toBe(201);
  });

  it("library media can be saved on posts (even several), and neither pruning nor the sweeper deletes it", async () => {
    const a = await signup();
    const media = await newMedia(a.workspaceId, a.userId);
    const plain = await newMedia(a.workspaceId, a.userId, "plain.png");
    expect((await a.call("post", `/library/from-media/${media.id}`)).status).toBe(201);
    const postsApp = express();
    postsApp.use(cookieParser(process.env.SESSION_SECRET));
    postsApp.use(express.json());
    const { default: postsRouter } = await import("./posts");
    postsApp.use("/api", postsRouter);
    const cookie = a.cookie;
    const save = (mediaIds: string[]) => request(postsApp).post("/api/posts").set("Cookie", cookie).send({ content: "x", connectedAccountIds: [], mediaIds });
    const first = await save([media.id]);
    expect(first.status).toBe(201);
    expect((await save([media.id])).status).toBe(201); // shared library media is reusable
    expect((await save([plain.id])).status).toBe(201);
    expect((await save([plain.id])).status).toBe(400); // ordinary uploads stay single-use

    const { pruneUnattachedMedia, sweepOrphanMedia } = await import("../lib/media");
    await request(postsApp).patch(`/api/posts/${first.body.id}`).set("Cookie", cookie).send({ mediaIds: [] });
    await pruneUnattachedMedia(a.workspaceId, [media.id]);
    await sweepOrphanMedia(new Date(Date.now() + 30 * 24 * 3600_000));
    const [still] = await db.select().from(mediaTable).where(eq(mediaTable.id, media.id));
    expect(still).toBeTruthy();
  });

  it("manages flat folders with unique names, and filters by folder", async () => {
    const a = await signup();
    const f = await a.call("post", "/library/folders").send({ name: "Summer" });
    expect(f.status).toBe(201);
    expect((await a.call("post", "/library/folders").send({ name: "summer" })).status).toBe(409);
    expect((await a.call("patch", `/library/folders/${f.body.id}`).send({ name: "Winter" })).body.name).toBe("Winter");
    const item = (await a.call("post", "/library").send({ kind: "caption", title: "c", body: "b", folderId: f.body.id })).body;
    expect((await a.call("get", `/library?folder=${f.body.id}`)).body.items).toHaveLength(1);
    expect((await a.call("get", "/library/folders")).body.folders[0]).toMatchObject({ name: "Winter", itemCount: 1 });
    expect((await a.call("delete", `/library/folders/${f.body.id}`)).status).toBe(204);
    const after = await a.call("get", "/library?folder=none");
    expect(after.body.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
  });

  it("isolates workspaces", async () => {
    const a = await signup();
    const b = await signup();
    const item = (await a.call("post", "/library").send({ kind: "caption", title: "Secret", body: "mine" })).body;
    const folder = (await a.call("post", "/library/folders").send({ name: "Private" })).body;
    const media = await newMedia(a.workspaceId, a.userId);
    expect((await b.call("get", "/library")).body.items).toHaveLength(0);
    expect((await b.call("patch", `/library/${item.id}`).send({ title: "x" })).status).toBe(404);
    expect((await b.call("delete", `/library/${item.id}`)).status).toBe(404);
    expect((await b.call("post", `/library/${item.id}/use`)).status).toBe(404);
    expect((await b.call("post", `/library/${item.id}/render`).send({})).status).toBe(404);
    expect((await b.call("post", "/library/folders").send({ name: "Private" })).status).toBe(201);
    expect((await b.call("delete", `/library/folders/${folder.id}`)).status).toBe(404);
    expect((await b.call("post", `/library/from-media/${media.id}`)).status).toBe(404);
    expect((await b.call("post", "/library").send({ kind: "media", title: "t", mediaId: media.id })).status).toBe(404);
    expect((await b.call("post", "/library").send({ kind: "caption", title: "t", body: "b", folderId: folder.id })).status).toBe(404);
  });

  it("lets viewers read but not write", async () => {
    const v = await signup("viewer");
    expect((await v.call("get", "/library")).status).toBe(200);
    expect((await v.call("post", "/library").send({ kind: "caption", title: "t", body: "b" })).status).toBe(403);
    expect((await v.call("post", "/library/folders").send({ name: "F" })).status).toBe(403);
    const e = await signup("editor");
    expect((await e.call("post", "/library").send({ kind: "caption", title: "t", body: "b" })).status).toBe(201);
  });
});

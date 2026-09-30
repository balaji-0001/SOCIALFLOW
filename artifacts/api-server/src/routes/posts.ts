import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { isPublishBlockedByApproval, resetApprovalOnEdit } from "../lib/approvals";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreatePostBody,
  DeletePostParams,
  GetPostParams,
  ListPostsResponse,
  UpdatePostBody,
  UpdatePostParams,
  PublishPostNowParams,
  PublishPostNowResponse,
  CreatePostResponse,
  GetPostResponse,
  UpdatePostResponse,
} from "@workspace/api-zod";
import {
  connectedAccountsTable,
  db,
  mediaTable,
  postMediaTable,
  postStatuses,
  postTagsTable,
  postTargetsTable,
  postsTable,
  type Post,
  type PostStatus,
} from "@workspace/db";
import { jsonError } from "../lib/http-errors";
import { mediaProblemForPlatforms, type RuleMedia } from "../lib/media-rules";
import { loadMediaForPosts, pruneUnattachedMedia, serializeMedia, validateMediaIds } from "../lib/media";
import {
  MAX_FIRST_COMMENT_LENGTH,
  linkColumns,
  linkFromRow,
  parsePostLink,
  type PostLink,
  effectiveContent,
  loadExtrasForPosts,
  parsePlatformContent,
  platformContentProblem,
  validateCustomValues,
  validateTagIds,
  writePostExtras,
  type CustomValues,
  type PlatformContent,
} from "../lib/post-extras";
import {
  claimPostForPublishNow,
  postUrl,
  publishClaimedPost,
} from "../lib/publisher";
import { nextFreeSlot } from "../lib/queue";
import type { Platform } from "../lib/oauth/types";
import { requireAccess } from "../lib/access";
import type { WorkspaceContext } from "../lib/session";

const router: IRouter = Router();

const MAX_CONTENT_LENGTH = 10_000;

async function requireWorkspace(req: Request, res: Response): Promise<WorkspaceContext | null> {
  return requireAccess(req, res, req.method === "GET" ? "posts:read" : req.method === "DELETE" ? "posts:delete" : req.path.endsWith("/publish") ? "posts:publish" : "posts:write");
}

export async function serializePosts(rows: Post[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const mediaByPost = await loadMediaForPosts(ids);
  const extrasByPost = await loadExtrasForPosts(ids);
  const targetRows = await db
    .select({
      postId: postTargetsTable.postId,
      connectedAccountId: postTargetsTable.connectedAccountId,
      status: postTargetsTable.status,
      errorMessage: postTargetsTable.errorMessage,
      externalPostId: postTargetsTable.externalPostId,
      firstCommentStatus: postTargetsTable.firstCommentStatus,
      firstCommentError: postTargetsTable.firstCommentError,
      platform: connectedAccountsTable.platform,
      accountName: connectedAccountsTable.displayName,
      avatarUrl: connectedAccountsTable.avatarUrl,
    })
    .from(postTargetsTable)
    .innerJoin(connectedAccountsTable, eq(connectedAccountsTable.id, postTargetsTable.connectedAccountId))
    .where(inArray(postTargetsTable.postId, ids))
    .orderBy(asc(connectedAccountsTable.platform), asc(connectedAccountsTable.displayName));

  return rows.map((row) => {
    const extras = extrasByPost.get(row.id)!;
    return {
      id: row.id,
      content: row.content,
      platformContent: extras.platformContent,
      firstComment: row.firstComment,
      link: linkFromRow(row),
      status: row.status,
      scheduledAt: row.scheduledAt,
      publishedAt: row.publishedAt,
      recurrenceId: row.recurrenceId,
      targets: targetRows
        .filter((target) => target.postId === row.id)
        .map(({ postId: _postId, externalPostId, ...target }) => ({ ...target, postUrl: postUrl(target.platform, externalPostId) })),
      media: (mediaByPost.get(row.id) ?? []).map(serializeMedia),
      tags: extras.tags,
      customValues: extras.customValues,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

/** Kind and type of each file, for checking them against what the selected networks accept. */
async function mediaForRules(workspaceId: string, ids: string[]): Promise<RuleMedia[]> {
  if (ids.length === 0) return [];
  return db.select({ kind: mediaTable.kind, mimeType: mediaTable.mimeType, sizeBytes: mediaTable.sizeBytes }).from(mediaTable).where(and(eq(mediaTable.workspaceId, workspaceId), inArray(mediaTable.id, ids)));
}

type TargetAccount = { id: string; status: string; name: string; platform: Platform };

async function loadTargetAccounts(workspaceId: string, accountIds: string[]): Promise<TargetAccount[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({ id: connectedAccountsTable.id, status: connectedAccountsTable.status, name: connectedAccountsTable.displayName, platform: connectedAccountsTable.platform })
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.workspaceId, workspaceId), inArray(connectedAccountsTable.id, accountIds)));
  return rows.map((row) => ({ ...row, platform: row.platform as Platform }));
}

/** Confirms every account exists in this workspace and is usable, and (when publishing) that the networks can take the media and text. */
async function validateTargets(workspaceId: string, accountIds: string[], forPublishing: boolean, media: RuleMedia[], content: string, platformContent: PlatformContent, hasLinkImage = false): Promise<string | null> {
  if (accountIds.length === 0) return null;
  const accounts = await loadTargetAccounts(workspaceId, accountIds);
  if (accounts.length !== new Set(accountIds).size) return "One or more selected accounts don't exist in this workspace.";
  const unhealthy = accounts.find((account) => account.status !== "active");
  if (unhealthy) return `${unhealthy.name} needs to be reconnected before it can be used.`;
  if (forPublishing) {
    for (const platform of new Set(accounts.map((account) => account.platform))) {
      if (effectiveContent(content, platformContent, platform).trim().length === 0) return "Write something before scheduling this post.";
    }
    const mediaProblem = mediaProblemForPlatforms(accounts.map((account) => account.platform), media, { hasLinkImage });
    if (mediaProblem) return mediaProblem;
  }
  return null;
}

/** Rules that only apply once a post is scheduled rather than saved as a draft. */
function validateSchedulable(content: string, platformContent: PlatformContent, accountIds: string[], scheduledAt: Date): string | null {
  if (content.trim().length === 0 && Object.keys(platformContent).length === 0) return "Write something before scheduling this post.";
  if (accountIds.length === 0) return "Choose at least one account to post to.";
  if (scheduledAt.getTime() <= Date.now()) return "Pick a time in the future.";
  return null;
}

function parseDateParam(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Fields shared by create and update: parsed and checked, or an error message. */
type ExtrasInput = { platformContent?: PlatformContent; tagIds?: string[]; customValues?: CustomValues; firstComment?: string | null; link?: PostLink | null };

async function parseExtras(workspaceId: string, body: Record<string, unknown>, strict: boolean): Promise<{ ok: true; extras: ExtrasInput } | { ok: false; message: string }> {
  const extras: ExtrasInput = {};
  if (body.platformContent !== undefined) {
    const parsed = parsePlatformContent(body.platformContent);
    if (!parsed) return { ok: false, message: "Per-network text isn't valid." };
    const problem = platformContentProblem(parsed);
    if (problem) return { ok: false, message: problem };
    extras.platformContent = parsed;
  }
  if (body.tagIds !== undefined) {
    if (!Array.isArray(body.tagIds) || body.tagIds.some((id) => typeof id !== "string")) return { ok: false, message: "Tags aren't valid." };
    const problem = await validateTagIds(workspaceId, body.tagIds as string[]);
    if (problem) return { ok: false, message: problem };
    extras.tagIds = body.tagIds as string[];
  }
  if (body.customValues !== undefined) {
    if (!body.customValues || typeof body.customValues !== "object" || Array.isArray(body.customValues)) return { ok: false, message: "Custom fields aren't valid." };
    const values = body.customValues as CustomValues;
    const problem = await validateCustomValues(workspaceId, values, strict);
    if (problem) return { ok: false, message: problem };
    extras.customValues = values;
  }
  if (body.firstComment !== undefined) {
    if (body.firstComment !== null && typeof body.firstComment !== "string") return { ok: false, message: "The first comment isn't valid." };
    const text = typeof body.firstComment === "string" ? body.firstComment : null;
    if (text && text.length > MAX_FIRST_COMMENT_LENGTH) return { ok: false, message: `The first comment can be up to ${MAX_FIRST_COMMENT_LENGTH.toLocaleString()} characters.` };
    extras.firstComment = text && text.trim().length > 0 ? text : null;
  }
  if (body.link !== undefined) {
    const parsedLink = parsePostLink(body.link);
    if (!parsedLink.ok) return { ok: false, message: parsedLink.message };
    extras.link = parsedLink.link;
  }
  return { ok: true, extras };
}

router.get("/posts", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;

  const from = parseDateParam(req.query.from);
  const to = parseDateParam(req.query.to);
  if (from === null || to === null) return jsonError(res, 400, "invalid_query", "from and to must be ISO dates.");
  const status = req.query.status;
  if (status !== undefined && !postStatuses.includes(status as PostStatus)) {
    return jsonError(res, 400, "invalid_query", "Unknown status.");
  }
  const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";

  const conditions = [eq(postsTable.workspaceId, ctx.workspaceId)];
  if (from) conditions.push(gte(postsTable.scheduledAt, from));
  if (to) conditions.push(lte(postsTable.scheduledAt, to));
  if (status) conditions.push(eq(postsTable.status, status as PostStatus));
  if (tag) conditions.push(sql`exists (select 1 from ${postTagsTable} where ${postTagsTable.postId} = ${postsTable.id} and ${postTagsTable.tagId} = ${tag}::uuid)`);
  if (search) conditions.push(sql`(${postsTable.content} ilike ${"%" + search + "%"} or exists (select 1 from socialflow_post_platform_content c where c.post_id = ${postsTable.id} and c.content ilike ${"%" + search + "%"}))`);

  const rows = await db.select().from(postsTable).where(and(...conditions)).orderBy(asc(postsTable.scheduledAt), asc(postsTable.createdAt));
  res.json(ListPostsResponse.parse({ posts: await serializePosts(rows) }));
});

router.post("/posts", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;

  const parsed = CreatePostBody.safeParse(req.body);
  if (!parsed.success) return jsonError(res, 400, "invalid_post", "That post isn't valid.");
  const { content } = parsed.data;
  const accountIds = [...new Set(parsed.data.connectedAccountIds)];
  if (content.length > MAX_CONTENT_LENGTH) return jsonError(res, 400, "invalid_post", "That post is too long.");

  // "Add to queue" picks the time from the accounts' posting schedules.
  let scheduledAt = parsed.data.scheduledAt ?? null;
  if (parsed.data.queue) {
    const slot = await nextFreeSlot(ctx.workspaceId, accountIds);
    if (!slot.ok) return jsonError(res, 400, "invalid_post", slot.message);
    scheduledAt = slot.slot.at;
  }
  const extrasResult = await parseExtras(ctx.workspaceId, req.body as Record<string, unknown>, Boolean(scheduledAt));
  if (!extrasResult.ok) return jsonError(res, 400, "invalid_post", extrasResult.message);
  const { extras } = extrasResult;
  const platformContent = extras.platformContent ?? {};

  if (scheduledAt) {
    const problem = validateSchedulable(content, platformContent, accountIds, scheduledAt);
    if (problem) return jsonError(res, 400, "invalid_post", problem);
  }
  const mediaIds = parsed.data.mediaIds ?? [];
  const mediaProblem = await validateMediaIds(ctx.workspaceId, mediaIds);
  if (mediaProblem) return jsonError(res, 400, "invalid_post", mediaProblem);
  const targetProblem = await validateTargets(ctx.workspaceId, accountIds, Boolean(scheduledAt), await mediaForRules(ctx.workspaceId, mediaIds), content, platformContent, Boolean(extras.link?.imageUrl));
  if (targetProblem) return jsonError(res, 400, "invalid_post", targetProblem);

  const status: PostStatus = scheduledAt ? "scheduled" : "draft";
  const created = await db.transaction(async (tx) => {
    const [post] = await tx
      .insert(postsTable)
      .values({ workspaceId: ctx.workspaceId, createdByUserId: ctx.userId, content, status, scheduledAt, firstComment: extras.firstComment ?? null, ...linkColumns(extras.link ?? null) })
      .returning();
    if (accountIds.length > 0) {
      await tx.insert(postTargetsTable).values(accountIds.map((connectedAccountId) => ({ postId: post!.id, connectedAccountId, status })));
    }
    if (mediaIds.length > 0) {
      await tx.insert(postMediaTable).values(mediaIds.map((mediaId, position) => ({ postId: post!.id, mediaId, position })));
    }
    await writePostExtras(tx, post!.id, extras);
    return post!;
  });

  const [serialized] = await serializePosts([created]);
  res.status(201).json(CreatePostResponse.parse(serialized));
});

async function findPost(workspaceId: string, postId: string): Promise<Post | null> {
  const [row] = await db
    .select()
    .from(postsTable)
    .where(and(eq(postsTable.id, postId), eq(postsTable.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

router.get("/posts/:postId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const params = GetPostParams.safeParse(req.params);
  if (!params.success) return jsonError(res, 404, "not_found", "Post not found.");
  const row = await findPost(ctx.workspaceId, params.data.postId);
  if (!row) return jsonError(res, 404, "not_found", "Post not found.");
  const [serialized] = await serializePosts([row]);
  res.json(GetPostResponse.parse(serialized));
});

router.patch("/posts/:postId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const params = UpdatePostParams.safeParse(req.params);
  if (!params.success) return jsonError(res, 404, "not_found", "Post not found.");
  const body = UpdatePostBody.safeParse(req.body);
  if (!body.success) return jsonError(res, 400, "invalid_post", "That post isn't valid.");

  const existing = await findPost(ctx.workspaceId, params.data.postId);
  if (!existing) return jsonError(res, 404, "not_found", "Post not found.");
  if (existing.status === "published") return jsonError(res, 400, "invalid_post", "A published post can't be edited.");
  if (existing.status === "publishing") return jsonError(res, 400, "invalid_post", "This post is being published right now. Try again in a moment.");
  // Editing would reset per-account state and could send a post that already went out a second time.
  const [alreadySent] = await db
    .select({ id: postTargetsTable.id })
    .from(postTargetsTable)
    .where(and(eq(postTargetsTable.postId, existing.id), eq(postTargetsTable.status, "published")))
    .limit(1);
  if (alreadySent) return jsonError(res, 400, "invalid_post", "This post already went out to some accounts. Use Publish now to retry the rest, or create a new post.");

  const content = body.data.content ?? existing.content;
  if (content.length > MAX_CONTENT_LENGTH) return jsonError(res, 400, "invalid_post", "That post is too long.");

  let accountIds: string[];
  if (body.data.connectedAccountIds) {
    accountIds = [...new Set(body.data.connectedAccountIds)];
  } else {
    const current = await db.select({ id: postTargetsTable.connectedAccountId }).from(postTargetsTable).where(eq(postTargetsTable.postId, existing.id));
    accountIds = current.map((row) => row.id);
  }

  // undefined = leave the schedule alone; null = back to draft; a date = (re)schedule; queue = next free slot.
  let scheduledAt = body.data.scheduledAt === undefined ? existing.scheduledAt : body.data.scheduledAt;
  let scheduleChanged = body.data.scheduledAt !== undefined;
  if (body.data.queue) {
    const slot = await nextFreeSlot(ctx.workspaceId, accountIds);
    if (!slot.ok) return jsonError(res, 400, "invalid_post", slot.message);
    scheduledAt = slot.slot.at;
    scheduleChanged = true;
  }
  const extrasResult = await parseExtras(ctx.workspaceId, req.body as Record<string, unknown>, Boolean(scheduledAt));
  if (!extrasResult.ok) return jsonError(res, 400, "invalid_post", extrasResult.message);
  const { extras } = extrasResult;
  const currentExtras = (await loadExtrasForPosts([existing.id])).get(existing.id)!;
  const platformContent = extras.platformContent ?? currentExtras.platformContent;
  if (scheduledAt && extras.customValues === undefined) {
    // Required custom fields are checked against the stored values when the request doesn't send new ones.
    const problem = await validateCustomValues(ctx.workspaceId, currentExtras.customValues, true);
    if (problem) return jsonError(res, 400, "invalid_post", problem);
  }

  if (scheduledAt && (scheduleChanged || existing.status === "failed")) {
    const problem = validateSchedulable(content, platformContent, accountIds, scheduledAt);
    if (problem) return jsonError(res, 400, "invalid_post", problem);
  } else if (scheduledAt) {
    if (content.trim().length === 0 && Object.keys(platformContent).length === 0) return jsonError(res, 400, "invalid_post", "A scheduled post can't be empty.");
    if (accountIds.length === 0) return jsonError(res, 400, "invalid_post", "A scheduled post needs at least one account.");
  }
  // undefined = leave the media alone; an array replaces the set and order.
  const newMediaIds = body.data.mediaIds;
  const previousMedia = await db.select({ id: postMediaTable.mediaId }).from(postMediaTable).where(eq(postMediaTable.postId, existing.id));
  if (newMediaIds) {
    const mediaProblem = await validateMediaIds(ctx.workspaceId, newMediaIds, existing.id);
    if (mediaProblem) return jsonError(res, 400, "invalid_post", mediaProblem);
  }
  if (body.data.connectedAccountIds || body.data.mediaIds || scheduledAt) {
    const finalMediaIds = newMediaIds ?? previousMedia.map((row) => row.id);
    const finalLink = extras.link !== undefined ? extras.link : linkFromRow(existing);
    const targetProblem = await validateTargets(ctx.workspaceId, accountIds, Boolean(scheduledAt), await mediaForRules(ctx.workspaceId, finalMediaIds), content, platformContent, Boolean(finalLink?.imageUrl));
    if (targetProblem) return jsonError(res, 400, "invalid_post", targetProblem);
  }

  const status: PostStatus = scheduledAt ? "scheduled" : "draft";
  const saved = await db.transaction(async (tx) => {
    // The claim (scheduler or Publish now) can land at any moment after we read the post above, so the
    // write itself must be conditional, and the row is locked so a claim can't slip in mid-edit. Without
    // this an edit could reset a post the publisher is already sending, or drop its per-account results.
    const locked = await tx.execute(sql`select status from socialflow_posts where id = ${existing.id} and workspace_id = ${ctx.workspaceId} for update`);
    const current = (locked.rows[0] as { status?: string } | undefined)?.status;
    if (current !== "draft" && current !== "scheduled" && current !== "failed") return false;
    const [sent] = await tx
      .select({ id: postTargetsTable.id })
      .from(postTargetsTable)
      .where(and(eq(postTargetsTable.postId, existing.id), eq(postTargetsTable.status, "published")))
      .limit(1);
    if (sent) return false;
    await tx
      .update(postsTable)
      .set({ content, status, scheduledAt: scheduledAt ?? null, ...(extras.firstComment !== undefined ? { firstComment: extras.firstComment } : {}), ...(extras.link !== undefined ? linkColumns(extras.link) : {}) })
      .where(eq(postsTable.id, existing.id));
    if (body.data.connectedAccountIds) {
      await tx.delete(postTargetsTable).where(eq(postTargetsTable.postId, existing.id));
      if (accountIds.length > 0) {
        await tx.insert(postTargetsTable).values(accountIds.map((connectedAccountId) => ({ postId: existing.id, connectedAccountId, status })));
      }
    } else {
      await tx.update(postTargetsTable).set({ status, errorMessage: null, firstCommentStatus: null, firstCommentError: null }).where(eq(postTargetsTable.postId, existing.id));
    }
    if (newMediaIds) {
      await tx.delete(postMediaTable).where(eq(postMediaTable.postId, existing.id));
      if (newMediaIds.length > 0) {
        await tx.insert(postMediaTable).values(newMediaIds.map((mediaId, position) => ({ postId: existing.id, mediaId, position })));
      }
    }
    await writePostExtras(tx, existing.id, extras);
    return true;
  });
  if (saved && newMediaIds) {
    // Files the post no longer carries are deleted, so removing media in the composer really frees the storage.
    await pruneUnattachedMedia(ctx.workspaceId, previousMedia.map((row) => row.id).filter((id) => !newMediaIds.includes(id)));
  }
  if (!saved) return jsonError(res, 400, "invalid_post", "This post is being published or has already gone out, so it can't be changed right now. Refresh and try again.");

  // An approved post that changes needs a fresh look.
  await resetApprovalOnEdit(existing.id);
  const updated = (await findPost(ctx.workspaceId, existing.id))!;
  const [serialized] = await serializePosts([updated]);
  res.json(UpdatePostResponse.parse(serialized));
});

router.delete("/posts/:postId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const params = DeletePostParams.safeParse(req.params);
  if (!params.success) return jsonError(res, 404, "not_found", "Post not found.");
  const carried = await db.select({ id: postMediaTable.mediaId }).from(postMediaTable).where(eq(postMediaTable.postId, params.data.postId));
  // The status check is part of the DELETE, so a claim between "check" and "delete" can't be missed.
  const deleted = await db
    .delete(postsTable)
    .where(and(eq(postsTable.id, params.data.postId), eq(postsTable.workspaceId, ctx.workspaceId), ne(postsTable.status, "publishing")))
    .returning({ id: postsTable.id });
  if (deleted.length === 0) {
    const stillThere = await findPost(ctx.workspaceId, params.data.postId);
    if (stillThere) return jsonError(res, 400, "invalid_post", "This post is being published right now. Try again in a moment.");
    return jsonError(res, 404, "not_found", "Post not found.");
  }
  await pruneUnattachedMedia(ctx.workspaceId, carried.map((row) => row.id));
  res.sendStatus(204);
});

/**
 * Publishes a post immediately: a draft, a scheduled post, or a failed post
 * to retry. Runs synchronously so the caller sees the real result; per-account
 * outcomes are on the returned targets (a failed publish is still a 200).
 */
router.post("/posts/:postId/publish", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const params = PublishPostNowParams.safeParse(req.params);
  if (!params.success) return jsonError(res, 404, "not_found", "Post not found.");
  const existing = await findPost(ctx.workspaceId, params.data.postId);
  if (!existing) return jsonError(res, 404, "not_found", "Post not found.");
  if (existing.status === "published") return jsonError(res, 400, "invalid_post", "This post has already been published.");
  if (existing.status === "publishing") return jsonError(res, 400, "invalid_post", "This post is already being published.");

  if (await isPublishBlockedByApproval(existing.id)) return jsonError(res, 409, "approval_required", "This workspace requires approval before publishing. Send the post for approval first.");
  const pending = await db
    .select({ id: postTargetsTable.connectedAccountId })
    .from(postTargetsTable)
    .where(and(eq(postTargetsTable.postId, existing.id), ne(postTargetsTable.status, "published")));
  const accountIds = pending.map((row) => row.id);
  const extras = (await loadExtrasForPosts([existing.id])).get(existing.id)!;
  if (existing.content.trim().length === 0 && Object.keys(extras.platformContent).length === 0) return jsonError(res, 400, "invalid_post", "Write something before publishing this post.");
  if (accountIds.length === 0) return jsonError(res, 400, "invalid_post", "Choose at least one account to publish to.");
  const fieldProblem = await validateCustomValues(ctx.workspaceId, extras.customValues, true);
  if (fieldProblem) return jsonError(res, 400, "invalid_post", fieldProblem);
  const carried = await db.select({ id: postMediaTable.mediaId }).from(postMediaTable).where(eq(postMediaTable.postId, existing.id));
  const problem = await validateTargets(ctx.workspaceId, accountIds, true, await mediaForRules(ctx.workspaceId, carried.map((row) => row.id)), existing.content, extras.platformContent, Boolean(linkFromRow(existing)?.imageUrl));
  if (problem) return jsonError(res, 400, "invalid_post", problem);

  if (!(await claimPostForPublishNow(ctx.workspaceId, existing.id))) {
    return jsonError(res, 400, "invalid_post", "This post is already being published.");
  }
  await publishClaimedPost(existing.id);

  const updated = (await findPost(ctx.workspaceId, existing.id))!;
  const [serialized] = await serializePosts([updated]);
  req.log.info({ postId: existing.id, status: updated.status }, "Post published on demand");
  res.json(PublishPostNowResponse.parse(serialized));
});

export default router;

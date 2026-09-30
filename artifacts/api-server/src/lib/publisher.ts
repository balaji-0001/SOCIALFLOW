import { existsSync } from "node:fs";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  connectedAccountsTable,
  db,
  postTargetsTable,
  postsTable,
  type ConnectedAccount,
} from "@workspace/db";
import { publishBlockedSql } from "./approvals";
import { prepareLinkPhoto } from "./link-photo";
import { logger } from "./logger";
import { loadMediaForPosts, signedPublicMediaUrl, storedFilePath } from "./media";
import { mediaProblemForPlatform } from "./media-rules";
import { effectiveContent, linkFromRow, linkNoteForPlatform, loadPlatformContent, type PostLink } from "./post-extras";
import { materializeDueRecurrences } from "./recurrence";
import { ensureFreshToken, markAccountStatus, readCredentials } from "./oauth/accounts";
import { OAuthError, type OAuthErrorCode } from "./oauth/errors";
import { getAdapter } from "./oauth/registry";
import type { OAuthProviderAdapter, Platform, PublishMedia } from "./oauth/types";

/*
 * Publishing engine.
 *
 * Delivery guarantee: at most once. A post is claimed (status -> publishing)
 * in a single atomic statement before any network call, so two cycles or two
 * server instances can never send the same post. If the process dies between
 * "claimed" and "result recorded" we cannot know whether the network accepted
 * the post, so it is NOT retried automatically: after STALE_PUBLISHING_MS it is
 * marked failed with an explanation, and the user decides whether to retry.
 * Automatically retrying could publish the same post twice.
 */

/** Networks that can't take a text-only post. */
export const MEDIA_REQUIRED_PLATFORMS: readonly Platform[] = ["instagram", "youtube"];

export const PLATFORM_CHAR_LIMITS: Record<Platform, number> = {
  facebook: 63_206,
  instagram: 2_200,
  linkedin: 3_000,
  youtube: 5_000,
};

export function mediaRequiredMessage(platforms: Platform[]): string {
  const names = [...new Set(platforms)].map((p) => (p === "instagram" ? "Instagram" : "YouTube"));
  return `${names.join(" and ")} posts need an image or video.`;
}

const PLATFORM_NAMES: Record<Platform, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", youtube: "YouTube" };

/** A link to the published post on the network, when we can build one. */
export function postUrl(platform: string, externalPostId: string | null): string | null {
  if (!externalPostId) return null;
  if (platform === "facebook") return `https://www.facebook.com/${encodeURIComponent(externalPostId)}`;
  if (platform === "linkedin") return `https://www.linkedin.com/feed/update/${encodeURIComponent(externalPostId)}`;
  if (platform === "youtube") return `https://www.youtube.com/watch?v=${encodeURIComponent(externalPostId)}`;
  return null;
}

function envMinutes(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A due post older than this is not sent late; it's marked failed so the user can decide. */
const missedGraceMs = () => envMinutes("PUBLISH_MISSED_GRACE_MINUTES", 60) * 60_000;
const STALE_PUBLISHING_MS = 10 * 60_000;
const BATCH_SIZE = 10;
const CONCURRENCY = 3;
const MAX_ERROR_LENGTH = 500;

const INTERRUPTED_MESSAGE =
  "Publishing was interrupted before the network confirmed it. Check the network to see whether it went out before retrying.";

function missedMessage(): string {
  const minutes = Math.round(missedGraceMs() / 60_000);
  return `This post wasn't sent within ${minutes} minutes of its scheduled time (the server may have been offline). Publish it now or reschedule it.`;
}

/** A user-facing failure reason. Never includes tokens; provider messages come from the network's error body. */
function describeError(error: OAuthError): string {
  const detail = error.details.providerMessage?.trim();
  const text = detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message;
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

type TargetOutcome = { ok: true; externalPostId: string; notice?: string; adapter: OAuthProviderAdapter; account: ConnectedAccount } | { ok: false; message: string };

const fail = (message: string): TargetOutcome => ({ ok: false, message });

const ACCOUNT_STATUS_FOR: Partial<Record<OAuthErrorCode, "revoked" | "expired" | "missing_permissions">> = {
  token_revoked: "revoked",
  token_expired: "expired",
  insufficient_permissions: "missing_permissions",
};

async function publishToAccount(account: ConnectedAccount, content: string, media: PublishMedia[], link: PostLink | null): Promise<TargetOutcome> {
  const platform = account.platform as Platform;
  if (content.trim().length === 0) return fail("This post is empty.");
  const mediaProblem = mediaProblemForPlatform(platform, media, { hasLinkImage: Boolean(link?.imageUrl) });
  if (mediaProblem) return fail(mediaProblem);
  if (platform === "youtube" && /[<>]/.test(content)) return fail("YouTube doesn't allow < or > in a title or description.");
  if (content.length > PLATFORM_CHAR_LIMITS[platform]) {
    return fail(`This post is too long for ${PLATFORM_NAMES[platform]} (limit ${PLATFORM_CHAR_LIMITS[platform].toLocaleString()} characters).`);
  }
  if (account.status !== "active") {
    return fail(`${account.displayName} needs to be reconnected before it can post.${account.statusDetail ? ` ${account.statusDetail}` : ""}`);
  }

  let adapter;
  try {
    adapter = getAdapter(platform);
  } catch (error) {
    return fail(error instanceof OAuthError ? error.message : `${PLATFORM_NAMES[platform]} isn't available.`);
  }
  if (!adapter.publishPost) return fail(`${PLATFORM_NAMES[platform]} publishing isn't supported yet.`);

  const fresh = await ensureFreshToken(account, adapter);
  if (fresh.status !== "active") {
    return fail(`${account.displayName} needs to be reconnected.${fresh.statusDetail ? ` ${fresh.statusDetail}` : ""}`);
  }

  try {
    const { externalPostId, notice } = await adapter.publishPost(readCredentials(fresh), { text: content, media, link });
    // Networks that can't show a link card say so honestly; the post itself is unchanged.
    const linkNote = link ? linkNoteForPlatform(platform) : null;
    return { ok: true, externalPostId, notice: [notice, linkNote].filter(Boolean).join(" ") || undefined, adapter, account: fresh };
  } catch (error) {
    const oauthError = error instanceof OAuthError ? error : new OAuthError("publish_failed");
    if (!(error instanceof OAuthError)) {
      // A non-provider failure (network down, timeout). The request may or may not have
      // reached the network, so this is reported rather than silently retried.
      logger.warn({ platform, accountId: account.id, errorName: error instanceof Error ? error.name : typeof error }, "Publish request failed before a provider response");
      return fail(`Couldn't reach ${PLATFORM_NAMES[platform]}. Check the network to see whether it went out before retrying.`);
    }
    const accountStatus = ACCOUNT_STATUS_FOR[oauthError.code];
    if (accountStatus) await markAccountStatus(account.id, accountStatus, oauthError.message);
    return fail(describeError(oauthError));
  }
}

/**
 * Publishes every target of an already-claimed post (targets in `publishing`),
 * records each result as it lands, and finalizes the post.
 */
export async function publishClaimedPost(postId: string): Promise<void> {
  const rows = await db
    .select({ target: postTargetsTable, account: connectedAccountsTable, content: postsTable.content, firstComment: postsTable.firstComment, post: postsTable })
    .from(postTargetsTable)
    .innerJoin(postsTable, eq(postsTable.id, postTargetsTable.postId))
    .innerJoin(connectedAccountsTable, eq(connectedAccountsTable.id, postTargetsTable.connectedAccountId))
    .where(and(eq(postTargetsTable.postId, postId), eq(postTargetsTable.status, "publishing")))
    .orderBy(asc(connectedAccountsTable.platform), asc(connectedAccountsTable.displayName));

  // The post's files, in the order the user arranged them. A file that has gone missing fails the post rather
  // than publishing it without that file.
  const stored = (await loadMediaForPosts([postId])).get(postId) ?? [];
  const media: PublishMedia[] = [];
  let missingFile: string | null = null;
  for (const item of stored) {
    const filePath = storedFilePath(item.storageKey);
    if (!filePath || !existsSync(filePath)) { missingFile = item.originalName; break; }
    media.push({ kind: item.kind, mimeType: item.mimeType, fileName: item.originalName, sizeBytes: item.sizeBytes, filePath, publicUrl: signedPublicMediaUrl(item.id) });
  }

  const platformContent = await loadPlatformContent(postId);

  // Instagram, link, nothing attached: the link's preview picture becomes the photo (see lib/link-photo.ts).
  // Converted and stored once per post, then reused for every Instagram account it goes to.
  let linkPhoto: { media: PublishMedia; note: string } | null | undefined;
  const linkPhotoFor = async (post: typeof rows[number]["post"], link: PostLink | null): Promise<{ media: PublishMedia; note: string } | null> => {
    if (linkPhoto !== undefined) return linkPhoto;
    if (media.length > 0 || !link?.imageUrl) return (linkPhoto = null);
    try {
      const photo = await prepareLinkPhoto(post.workspaceId, post.createdByUserId, link.imageUrl);
      linkPhoto = { media: photo, note: "Instagram can't show a clickable link, so the link's preview picture was posted as the photo." };
    } catch (error) {
      // The adapter still has its own last resort (handing Instagram the picture's URL to fetch itself).
      logger.warn({ postId, errorName: error instanceof Error ? error.name : typeof error }, "Couldn't prepare the link's picture for Instagram; falling back to its URL");
      linkPhoto = null;
    }
    return linkPhoto;
  };

  for (const { target, account, content: baseContent, firstComment, post } of rows) {
    const link = linkFromRow(post);
    const content = effectiveContent(baseContent, platformContent, account.platform as Platform);
    let outcome: TargetOutcome;
    try {
      if (missingFile) outcome = fail(`The file "${missingFile}" is no longer available. Remove it or upload it again.`);
      else {
        const photo = account.platform === "instagram" ? await linkPhotoFor(post, link) : null;
        outcome = await publishToAccount(account, content, photo ? [photo.media] : media, link);
        if (photo && outcome.ok) outcome = { ...outcome, notice: [photo.note, outcome.notice].filter(Boolean).join(" ") };
      }
    } catch (error) {
      logger.error({ err: error, postId, accountId: account.id }, "Unexpected error while publishing");
      outcome = fail("Something went wrong while publishing. Try again.");
    }
    await db
      .update(postTargetsTable)
      .set(
        outcome.ok
          ? { status: "published", externalPostId: outcome.externalPostId, errorMessage: outcome.notice ?? null }
          : { status: "failed", errorMessage: outcome.message },
      )
      .where(eq(postTargetsTable.id, target.id));
    logger.info({ postId, platform: account.platform, accountId: account.id, ok: outcome.ok }, "Publish attempt finished");
    // The first comment goes under the post once it exists. Its failure never fails the post: the post went out.
    if (outcome.ok && firstComment && firstComment.trim().length > 0) {
      const comment = await publishFirstComment(outcome.adapter, outcome.account, outcome.externalPostId, firstComment.trim());
      await db.update(postTargetsTable).set(comment).where(eq(postTargetsTable.id, target.id));
    }
  }
  await finalizePost(postId);
}

/** What a first comment needs on this account: supported, needs a permission the account was connected without, or unsupported. */
export function firstCommentSupport(platform: Platform, scopes: string[]): { state: "supported" | "needs_permission" | "unsupported"; scope: string | null } {
  let adapter: OAuthProviderAdapter;
  try {
    adapter = getAdapter(platform);
  } catch {
    return { state: "unsupported", scope: null };
  }
  if (!adapter.publishComment) return { state: "unsupported", scope: null };
  if (adapter.commentScope && !scopes.includes(adapter.commentScope)) return { state: "needs_permission", scope: adapter.commentScope };
  return { state: "supported", scope: adapter.commentScope ?? null };
}

async function publishFirstComment(adapter: OAuthProviderAdapter, account: ConnectedAccount, externalPostId: string, text: string) {
  const support = firstCommentSupport(account.platform as Platform, account.scopes);
  if (support.state === "unsupported") return { firstCommentStatus: "unsupported", firstCommentError: `${PLATFORM_NAMES[account.platform as Platform]} doesn't support first comments.` };
  if (support.state === "needs_permission") return { firstCommentStatus: "failed", firstCommentError: `The post went out, but commenting needs the ${support.scope} permission. Reconnect ${account.displayName} to grant it.` };
  try {
    const { externalCommentId } = await adapter.publishComment!(readCredentials(account), { externalPostId, text });
    return { firstCommentStatus: "published", firstCommentError: null, firstCommentExternalId: externalCommentId };
  } catch (error) {
    const message = error instanceof OAuthError ? describeError(error) : "The comment couldn't be posted.";
    logger.warn({ platform: account.platform, accountId: account.id }, "First comment failed");
    return { firstCommentStatus: "failed", firstCommentError: `The post went out, but the first comment failed: ${message}` };
  }
}

/** Sets the post's status from its targets: published only if every target published. */
async function finalizePost(postId: string): Promise<void> {
  const targets = await db.select({ status: postTargetsTable.status }).from(postTargetsTable).where(eq(postTargetsTable.postId, postId));
  const allPublished = targets.length > 0 && targets.every((t) => t.status === "published");
  await db
    .update(postsTable)
    .set(allPublished ? { status: "published", publishedAt: new Date() } : { status: "failed" })
    .where(and(eq(postsTable.id, postId), eq(postsTable.status, "publishing")));
}

/** Posts stuck in `publishing` (the process died mid-publish) become failed, never auto-retried. */
export async function recoverInterruptedPosts(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_PUBLISHING_MS);
  return db.transaction(async (tx) => {
    const stale = await tx
      .update(postsTable)
      .set({ status: "failed" })
      .where(and(eq(postsTable.status, "publishing"), lt(postsTable.updatedAt, cutoff)))
      .returning({ id: postsTable.id });
    if (stale.length === 0) return 0;
    const ids = stale.map((p) => p.id);
    await tx
      .update(postTargetsTable)
      .set({ status: "failed", errorMessage: INTERRUPTED_MESSAGE })
      .where(and(inArray(postTargetsTable.postId, ids), eq(postTargetsTable.status, "publishing")));
    // Every account may already have published before the crash (it died before the post was finalized);
    // that post went out, so calling it failed would strand it in a state nothing can move.
    const targets = await tx.select({ postId: postTargetsTable.postId, status: postTargetsTable.status }).from(postTargetsTable).where(inArray(postTargetsTable.postId, ids));
    const complete = ids.filter((id) => {
      const mine = targets.filter((t) => t.postId === id);
      return mine.length > 0 && mine.every((t) => t.status === "published");
    });
    if (complete.length > 0) await tx.update(postsTable).set({ status: "published", publishedAt: now }).where(inArray(postsTable.id, complete));
    return stale.length;
  });
}

/** Scheduled posts far past their time are failed instead of being sent late. */
export async function failMissedPosts(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - missedGraceMs());
  return db.transaction(async (tx) => {
    const missed = await tx
      .update(postsTable)
      .set({ status: "failed" })
      .where(and(eq(postsTable.status, "scheduled"), lt(postsTable.scheduledAt, cutoff), sql`not ${sql.raw(publishBlockedSql("socialflow_posts"))}`))
      .returning({ id: postsTable.id });
    if (missed.length === 0) return 0;
    await tx
      .update(postTargetsTable)
      .set({ status: "failed", errorMessage: missedMessage() })
      .where(and(inArray(postTargetsTable.postId, missed.map((p) => p.id)), eq(postTargetsTable.status, "scheduled")));
    return missed.length;
  });
}

/**
 * Atomically claims due scheduled posts. `FOR UPDATE SKIP LOCKED` makes
 * concurrent callers (cycles, instances) receive disjoint sets.
 */
export async function claimDuePosts(limit = BATCH_SIZE, now = new Date()): Promise<string[]> {
  return db.transaction(async (tx) => {
    const due = await tx.execute(sql`
      select id from socialflow_posts
      where status = 'scheduled' and scheduled_at <= ${now.toISOString()}::timestamptz
        and not ${sql.raw(publishBlockedSql("socialflow_posts"))}
      order by scheduled_at asc
      limit ${limit}
      for update skip locked`);
    const ids = (due.rows as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) return [];
    await tx.update(postsTable).set({ status: "publishing" }).where(inArray(postsTable.id, ids));
    await tx
      .update(postTargetsTable)
      .set({ status: "publishing", errorMessage: null })
      .where(and(inArray(postTargetsTable.postId, ids), eq(postTargetsTable.status, "scheduled")));
    return ids;
  });
}

/**
 * Claims one post for an immediate publish (drafts, scheduled posts, and
 * failed posts to retry). Only targets that haven't already published are
 * sent, so retrying a partly-failed post never duplicates the successes.
 * Returns false if the post isn't claimable (already publishing/published).
 */
export async function claimPostForPublishNow(workspaceId: string, postId: string, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(postsTable)
      .set({ status: "publishing", scheduledAt: now })
      .where(and(eq(postsTable.id, postId), eq(postsTable.workspaceId, workspaceId), inArray(postsTable.status, ["draft", "scheduled", "failed"])))
      .returning({ id: postsTable.id });
    if (!row) return false;
    await tx
      .update(postTargetsTable)
      .set({ status: "publishing", errorMessage: null })
      .where(and(eq(postTargetsTable.postId, postId), ne(postTargetsTable.status, "published")));
    return true;
  });
}

export interface PublishCycleResult { recovered: number; missed: number; claimed: number; materialized: number }

let cycleRunning = false;

/** One scheduler pass: recover interrupted posts, fail missed ones, publish what's due. */
export async function runPublishCycle(now = new Date()): Promise<PublishCycleResult> {
  if (cycleRunning) return { recovered: 0, missed: 0, claimed: 0, materialized: 0 };
  cycleRunning = true;
  try {
    const recovered = await recoverInterruptedPosts(now);
    const missed = await failMissedPosts(now);
    let materialized = 0;
    try {
      materialized = await materializeDueRecurrences(now);
    } catch (error) {
      logger.error({ err: error }, "Creating recurring post occurrences failed");
    }
    const ids = await claimDuePosts(BATCH_SIZE, now);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        try {
          await publishClaimedPost(id);
        } catch (error) {
          logger.error({ err: error, postId: id }, "Publishing a claimed post failed unexpectedly");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    if (recovered || missed || ids.length || materialized) logger.info({ recovered, missed, claimed: ids.length, materialized }, "Publish cycle finished");
    return { recovered, missed, claimed: ids.length, materialized };
  } finally {
    cycleRunning = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Starts the background scheduler. Safe to call once at server start. */
export function startPublisher(): void {
  if (timer || process.env.PUBLISHER_DISABLED === "true") return;
  const interval = Math.max(5_000, Number(process.env.PUBLISH_POLL_INTERVAL_MS) || 15_000);
  const tick = () => { runPublishCycle().catch((error) => logger.error({ err: error }, "Publish cycle failed")); };
  timer = setInterval(tick, interval);
  timer.unref();
  tick();
  logger.info({ intervalMs: interval }, "Publisher started");
}

export function stopPublisher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

import { and, eq, inArray } from "drizzle-orm";
import { connectedAccountsTable, db, mediaTable, postMediaTable, postTargetsTable, postsTable, type Post } from "@workspace/db";
import { mediaProblemForPlatforms, type RuleMedia } from "./media-rules";
import type { Platform } from "./oauth/types";
import { effectiveContent, linkColumns, writePostExtras, type PlatformContent, type PostLink } from "./post-extras";
import { PLATFORM_CHAR_LIMITS } from "./publisher";

/*
 * The checks and inserts behind creating a post, shared by POST /posts (routes/posts.ts), automations
 * (lib/automations.ts) and the CSV bulk import (lib/bulk-import.ts), so every way a post is made follows the same rules.
 */

export const MAX_CONTENT_LENGTH = 10_000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const PLATFORM_LABELS: Record<Platform, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", youtube: "YouTube" };

/** Kind and type of each file, for checking them against what the selected networks accept. */
export async function mediaForRules(workspaceId: string, ids: string[]): Promise<RuleMedia[]> {
  if (ids.length === 0) return [];
  return db.select({ kind: mediaTable.kind, mimeType: mediaTable.mimeType, sizeBytes: mediaTable.sizeBytes }).from(mediaTable).where(and(eq(mediaTable.workspaceId, workspaceId), inArray(mediaTable.id, ids)));
}

export type TargetAccount = { id: string; status: string; name: string; platform: Platform };

export async function loadTargetAccounts(workspaceId: string, accountIds: string[]): Promise<TargetAccount[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({ id: connectedAccountsTable.id, status: connectedAccountsTable.status, name: connectedAccountsTable.displayName, platform: connectedAccountsTable.platform })
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.workspaceId, workspaceId), inArray(connectedAccountsTable.id, accountIds)));
  return rows.map((row) => ({ ...row, platform: row.platform as Platform }));
}

/** Confirms every account exists in this workspace and is usable, and (when publishing) that the networks can take the media and text. */
export async function validateTargets(workspaceId: string, accountIds: string[], forPublishing: boolean, media: RuleMedia[], content: string, platformContent: PlatformContent, hasLinkImage = false): Promise<string | null> {
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

/** The first network whose character limit the text goes over, as a message, or null. */
export function charLimitProblem(content: string, platformList: Platform[]): string | null {
  for (const platform of new Set(platformList)) {
    if (content.length > PLATFORM_CHAR_LIMITS[platform]) return `The text is over ${PLATFORM_LABELS[platform]}'s ${PLATFORM_CHAR_LIMITS[platform].toLocaleString()} character limit.`;
  }
  return null;
}

export type NewPost = {
  workspaceId: string;
  userId: string | null;
  content: string;
  accountIds: string[];
  status: "draft" | "scheduled";
  scheduledAt: Date | null;
  link: PostLink | null;
  firstComment?: string | null;
  tagIds?: string[];
  mediaIds?: string[];
};

/** Inserts an already-validated post with its targets, media and tags. Runs inside the caller's transaction. */
export async function insertPost(tx: Tx, input: NewPost): Promise<Post> {
  const [post] = await tx
    .insert(postsTable)
    .values({ workspaceId: input.workspaceId, createdByUserId: input.userId, content: input.content, status: input.status, scheduledAt: input.scheduledAt, firstComment: input.firstComment ?? null, ...linkColumns(input.link) })
    .returning();
  const accountIds = [...new Set(input.accountIds)];
  if (accountIds.length > 0) {
    await tx.insert(postTargetsTable).values(accountIds.map((connectedAccountId) => ({ postId: post!.id, connectedAccountId, status: input.status })));
  }
  const mediaIds = input.mediaIds ?? [];
  if (mediaIds.length > 0) {
    await tx.insert(postMediaTable).values(mediaIds.map((mediaId, position) => ({ postId: post!.id, mediaId, position })));
  }
  if (input.tagIds && input.tagIds.length > 0) await writePostExtras(tx, post!.id, { tagIds: input.tagIds });
  return post!;
}

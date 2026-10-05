import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { connectedAccountsTable, db, excluded, postTargetsTable, postsTable, type ConnectedAccount } from "@workspace/db";
// Until the integrator exports the inbox schema from @workspace/db (see docs/integration/inbox.md), import it by path.
// After that, these can come from "@workspace/db" and this line can go.
import { inboxItemsTable, inboxRepliesTable, inboxSyncTable, type InboxItem, type InboxReply } from "@workspace/db";
import { logger } from "./logger";
import { ensureFreshToken, markAccountStatus, readCredentials } from "./oauth/accounts";
import { commentScopesEnabled, messagingScopesEnabled } from "./oauth/config";
import { OAuthError } from "./oauth/errors";
import {
  WINDOW_CLOSED_MESSAGE, fetchComments, fetchConversations, fetchMentions, inboxSupport, mentionReplySupport, mentionsSupport, messagingSupport, replyToComment, replyToMention, replyWindow, sendDirectMessage,
  type InboxCredentials, type InboxSupport,
} from "./oauth/inbox-adapters";
import { getAdapter } from "./oauth/registry";
import type { Platform } from "./oauth/types";

export { inboxItemsTable, inboxRepliesTable, inboxSyncTable };
export type { InboxItem, InboxReply };

/*
 * The comment inbox. For each account that was connected with the network's comment permission, the collector reads the
 * comments under its posts from the last 30 days and stores them (upsert by the network's comment ID, so status, read
 * marks and assignments survive every pass). An account without the permission gets an honest "permission needed" state
 * with the reason; nothing is ever made up. Replies go to the network first and are recorded either way.
 */

export const INBOX_WINDOW_DAYS = 30;
/** Most recent published posts read per account per pass, so one busy account can't use up a network's request budget. */
export const MAX_POSTS_PER_ACCOUNT = 25;

export type AvailabilityState = "available" | "permission_needed" | "unavailable" | "reconnect";

export interface Availability {
  state: AvailabilityState;
  reason: string | null;
}

/** What the inbox can do for an account right now: from its network, permissions and connection status. */
export function accountAvailability(account: Pick<ConnectedAccount, "platform" | "scopes" | "status">): Availability {
  const support: InboxSupport = inboxSupport(account.platform as Platform, account.scopes, commentScopesEnabled());
  if (support.state === "unavailable") return { state: "unavailable", reason: support.reason };
  if (account.status !== "active") return { state: "reconnect", reason: "Reconnect this account to read and answer its comments." };
  if (support.state === "permission_needed") return { state: "permission_needed", reason: support.reason };
  return { state: "available", reason: null };
}

function inboxCredentials(account: ConnectedAccount): InboxCredentials {
  const credentials = readCredentials(account);
  return {
    externalAccountId: credentials.externalAccountId,
    accessToken: credentials.accessToken,
    scopes: credentials.scopes ?? account.scopes,
    appSecret: account.platform === "facebook" ? process.env.FACEBOOK_APP_SECRET?.trim() || undefined : undefined,
    username: account.username,
  };
}

/** A safe, user-facing line for a failed call. Never includes tokens or request URLs. */
function describeFailure(error: unknown, accountId: string): { message: string; error: OAuthError | null } {
  if (error instanceof OAuthError) return { message: error.message, error };
  logger.warn({ err: error, accountId }, "Inbox call failed");
  return { message: "The network couldn't be reached. Try again in a few minutes.", error: null };
}

async function noteFailure(account: ConnectedAccount, error: OAuthError): Promise<void> {
  if (error.code === "token_revoked") await markAccountStatus(account.id, "revoked", error.message);
  else if (error.code === "token_expired") await markAccountStatus(account.id, "expired", error.message);
}

export type CollectState = "ok" | "permission_needed" | "unavailable" | "reconnect" | "error";
export interface InboxOutcome {
  accountId: string;
  state: CollectState;
  ok: boolean;
  postsRead: number;
  /** All new items of this pass: comments, and (when MESSAGING_SCOPES_ENABLED=true) messages and mentions. */
  newItems: number;
  reason: string | null;
  /** Set only when MESSAGING_SCOPES_ENABLED=true. */
  newMessages?: number;
  newMentions?: number;
  messagesReason?: string | null;
  mentionsReason?: string | null;
}

async function saveSync(accountId: string, values: { lastError: string | null; postsRead: number; synced: boolean }): Promise<void> {
  const now = new Date();
  await db
    .insert(inboxSyncTable)
    .values({ connectedAccountId: accountId, lastSyncedAt: values.synced ? now : null, lastError: values.lastError, postsRead: values.postsRead })
    .onConflictDoUpdate({ target: inboxSyncTable.connectedAccountId, set: { ...(values.synced ? { lastSyncedAt: now } : {}), lastError: values.lastError, postsRead: values.postsRead } });
}

/** Reads one account's comments and stores them. */
async function collectComments(account: ConnectedAccount, options: { now?: Date } = {}): Promise<InboxOutcome> {
  const now = options.now ?? new Date();
  const outcome: InboxOutcome = { accountId: account.id, state: "ok", ok: false, postsRead: 0, newItems: 0, reason: null };
  const availability = accountAvailability(account);
  if (availability.state !== "available") {
    outcome.state = availability.state;
    outcome.reason = availability.reason;
    await saveSync(account.id, { lastError: availability.reason, postsRead: 0, synced: false });
    return outcome;
  }
  const platform = account.platform as Platform;
  try {
    let fresh = account;
    try {
      fresh = await ensureFreshToken(account, getAdapter(platform));
    } catch (error) {
      if (error instanceof OAuthError && error.code === "not_configured") {
        outcome.state = "error";
        outcome.reason = error.message;
        await saveSync(account.id, { lastError: outcome.reason, postsRead: 0, synced: false });
        return outcome;
      }
      throw error;
    }
    if (fresh.status !== "active") {
      outcome.state = "reconnect";
      outcome.reason = "Reconnect this account to read and answer its comments.";
      await saveSync(account.id, { lastError: outcome.reason, postsRead: 0, synced: false });
      return outcome;
    }
    const creds = inboxCredentials(fresh);
    const since = new Date(now.getTime() - INBOX_WINDOW_DAYS * 86_400_000);
    const targets = await db
      .select({ targetId: postTargetsTable.id, externalPostId: postTargetsTable.externalPostId })
      .from(postTargetsTable)
      .innerJoin(postsTable, eq(postsTable.id, postTargetsTable.postId))
      .where(and(eq(postTargetsTable.connectedAccountId, account.id), eq(postTargetsTable.status, "published"), isNotNull(postTargetsTable.externalPostId), gte(postsTable.publishedAt, since)))
      .orderBy(desc(postsTable.publishedAt))
      .limit(MAX_POSTS_PER_ACCOUNT);

    // Replies sent from this app come back from the network as the account's own comments; they aren't inbox work.
    const sentReplies = await db
      .select({ externalId: inboxRepliesTable.externalId })
      .from(inboxRepliesTable)
      .innerJoin(inboxItemsTable, eq(inboxItemsTable.id, inboxRepliesTable.itemId))
      .where(and(eq(inboxItemsTable.connectedAccountId, account.id), isNotNull(inboxRepliesTable.externalId)));
    const ownReplyIds = new Set(sentReplies.map((row) => row.externalId!));

    let failures = 0;
    let lastFailure: string | null = null;
    for (const target of targets) {
      let comments;
      try {
        comments = await fetchComments(platform, creds, { externalPostId: target.externalPostId! });
      } catch (error) {
        const failure = describeFailure(error, account.id);
        if (failure.error) {
          await noteFailure(account, failure.error);
          // The network says the permission isn't there (or the token is gone, or it is rate limiting): no point asking again for every post.
          if (failure.error.code === "insufficient_permissions") {
            outcome.state = "permission_needed";
            outcome.reason = `The network refused to share comments: reconnect this account and allow the ${platform === "facebook" ? "pages_read_user_content and pages_manage_engagement" : "comment"} permission${platform === "facebook" ? "s" : ""}.`;
            await saveSync(account.id, { lastError: outcome.reason, postsRead: outcome.postsRead, synced: false });
            return outcome;
          }
          if (["token_revoked", "token_expired", "rate_limited"].includes(failure.error.code)) {
            outcome.state = failure.error.code === "rate_limited" ? "error" : "reconnect";
            outcome.reason = failure.message;
            await saveSync(account.id, { lastError: outcome.reason, postsRead: outcome.postsRead, synced: outcome.postsRead > 0 });
            return outcome;
          }
        }
        failures += 1;
        lastFailure = failure.message;
        continue;
      }
      outcome.postsRead += 1;
      const seen = new Set<string>();
      const wanted = comments.filter((comment) => {
        if (comment.fromSelf || ownReplyIds.has(comment.externalId) || seen.has(comment.externalId)) return false;
        seen.add(comment.externalId);
        return true;
      });
      if (wanted.length === 0) continue;
      const existing = await db
        .select({ externalId: inboxItemsTable.externalId })
        .from(inboxItemsTable)
        .where(and(eq(inboxItemsTable.connectedAccountId, account.id), inArray(inboxItemsTable.externalId, wanted.map((comment) => comment.externalId))));
      const known = new Set(existing.map((row) => row.externalId));
      await db
        .insert(inboxItemsTable)
        .values(wanted.map((comment) => ({
          workspaceId: account.workspaceId,
          connectedAccountId: account.id,
          postTargetId: target.targetId,
          platform,
          externalId: comment.externalId,
          externalPostId: target.externalPostId,
          parentExternalId: comment.parentExternalId,
          authorName: comment.authorName.slice(0, 300),
          authorAvatar: comment.authorAvatar,
          body: comment.body,
          createdAtNetwork: comment.createdAt,
        })))
        .onConflictDoUpdate({
          target: [inboxItemsTable.connectedAccountId, inboxItemsTable.externalId],
          // Only what the network owns is refreshed; status, read mark and assignment stay as people left them.
          set: { body: excluded(inboxItemsTable.body), authorName: excluded(inboxItemsTable.authorName), authorAvatar: excluded(inboxItemsTable.authorAvatar), postTargetId: excluded(inboxItemsTable.postTargetId) },
        });
      outcome.newItems += wanted.filter((comment) => !known.has(comment.externalId)).length;
    }
    outcome.ok = targets.length === 0 || outcome.postsRead > 0;
    if (!outcome.ok) {
      outcome.state = "error";
      outcome.reason = lastFailure ?? "The network couldn't be reached. Try again in a few minutes.";
    } else if (failures > 0) {
      outcome.reason = `${failures} post${failures === 1 ? "" : "s"} couldn't be read this time.`;
    }
    await saveSync(account.id, { lastError: outcome.state === "error" ? outcome.reason : failures > 0 ? outcome.reason : null, postsRead: outcome.postsRead, synced: outcome.ok });
  } catch (error) {
    const failure = describeFailure(error, account.id);
    if (failure.error) await noteFailure(account, failure.error);
    outcome.state = "error";
    outcome.reason = failure.message;
    await saveSync(account.id, { lastError: failure.message, postsRead: outcome.postsRead, synced: false }).catch(() => {});
  }
  return outcome;
}

// ------------------------------------------------------------------------------------- Messages and mentions

/** What direct messages can do for an account right now. Off (MESSAGING_SCOPES_ENABLED unset) it says so, with the reason. */
export function messagingAvailability(account: Pick<ConnectedAccount, "platform" | "scopes" | "status">): Availability {
  const support = messagingSupport(account.platform as Platform, account.scopes, messagingScopesEnabled());
  if (support.state === "unavailable") return { state: "unavailable", reason: support.reason };
  if (account.status !== "active") return { state: "reconnect", reason: "Reconnect this account to read and answer its messages." };
  if (support.state === "permission_needed") return { state: "permission_needed", reason: support.reason };
  return { state: "available", reason: null };
}

export function mentionsAvailability(account: Pick<ConnectedAccount, "platform" | "scopes" | "status">): Availability {
  const support = mentionsSupport(account.platform as Platform, account.scopes, messagingScopesEnabled());
  if (support.state === "unavailable") return { state: "unavailable", reason: support.reason };
  if (account.status !== "active") return { state: "reconnect", reason: "Reconnect this account to read its mentions." };
  if (support.state === "permission_needed") return { state: "permission_needed", reason: support.reason };
  return { state: "available", reason: null };
}

interface ExtrasOutcome {
  newMessages: number;
  newMentions: number;
  messagesReason: string | null;
  mentionsReason: string | null;
}

async function saveExtrasSync(accountId: string, values: { messagesError: string | null; mentionsError: string | null; messagesOk: boolean; mentionsOk: boolean }): Promise<void> {
  const now = new Date();
  const set = {
    messagesError: values.messagesError,
    mentionsError: values.mentionsError,
    ...(values.messagesOk ? { messagesSyncedAt: now } : {}),
    ...(values.mentionsOk ? { mentionsSyncedAt: now } : {}),
  };
  await db.insert(inboxSyncTable).values({ connectedAccountId: accountId, ...set }).onConflictDoUpdate({ target: inboxSyncTable.connectedAccountId, set });
}

function permissionReason(error: OAuthError, what: string): string {
  return `The network refused to share ${what}: reconnect this account and make sure the app has been approved for the ${what} permission.`;
}

/** Reads direct messages and mentions for one account (only when MESSAGING_SCOPES_ENABLED=true) and upserts them by the network's IDs. */
async function collectExtras(account: ConnectedAccount, now: Date): Promise<ExtrasOutcome | null> {
  if (!messagingScopesEnabled()) return null;
  const outcome: ExtrasOutcome = { newMessages: 0, newMentions: 0, messagesReason: null, mentionsReason: null };
  const messaging = messagingAvailability(account);
  const mentions = mentionsAvailability(account);
  outcome.messagesReason = messaging.state === "available" ? null : messaging.reason;
  outcome.mentionsReason = mentions.state === "available" ? null : mentions.reason;
  if (messaging.state !== "available" && mentions.state !== "available") {
    if (messaging.state !== "unavailable" || mentions.state !== "unavailable") await saveExtrasSync(account.id, { messagesError: outcome.messagesReason, mentionsError: outcome.mentionsReason, messagesOk: false, mentionsOk: false });
    return outcome;
  }
  const platform = account.platform as Platform;
  let messagesOk = false;
  let mentionsOk = false;
  try {
    let fresh: ConnectedAccount;
    try {
      fresh = await ensureFreshToken(account, getAdapter(platform));
    } catch (error) {
      const failure = describeFailure(error, account.id);
      if (failure.error) await noteFailure(account, failure.error);
      if (messaging.state === "available") outcome.messagesReason = failure.message;
      if (mentions.state === "available") outcome.mentionsReason = failure.message;
      await saveExtrasSync(account.id, { messagesError: outcome.messagesReason, mentionsError: outcome.mentionsReason, messagesOk: false, mentionsOk: false });
      return outcome;
    }
    if (fresh.status !== "active") {
      outcome.messagesReason = "Reconnect this account to read and answer its messages.";
      outcome.mentionsReason = "Reconnect this account to read its mentions.";
      await saveExtrasSync(account.id, { messagesError: outcome.messagesReason, mentionsError: outcome.mentionsReason, messagesOk: false, mentionsOk: false });
      return outcome;
    }
    const creds = inboxCredentials(fresh);
    const since = new Date(now.getTime() - INBOX_WINDOW_DAYS * 86_400_000);

    if (messaging.state === "available") {
      try {
        const threads = await fetchConversations(platform, creds);
        const rows = new Map<string, typeof inboxItemsTable.$inferInsert>();
        for (const thread of threads) {
          for (const message of thread.messages) {
            if (message.createdAt < since) continue;
            rows.set(message.externalId, {
              workspaceId: account.workspaceId,
              connectedAccountId: account.id,
              platform,
              kind: "message",
              externalId: message.externalId,
              threadId: thread.threadId,
              participantId: thread.participantId,
              fromPage: message.fromSelf,
              authorName: message.authorName.slice(0, 300),
              body: message.body,
              createdAtNetwork: message.createdAt,
            });
          }
        }
        const values = [...rows.values()];
        if (values.length) {
          const existing = await db.select({ externalId: inboxItemsTable.externalId }).from(inboxItemsTable).where(and(eq(inboxItemsTable.connectedAccountId, account.id), inArray(inboxItemsTable.externalId, [...rows.keys()])));
          const known = new Set(existing.map((row) => row.externalId));
          await db.insert(inboxItemsTable).values(values).onConflictDoUpdate({
            target: [inboxItemsTable.connectedAccountId, inboxItemsTable.externalId],
            set: { body: excluded(inboxItemsTable.body), authorName: excluded(inboxItemsTable.authorName), threadId: excluded(inboxItemsTable.threadId), participantId: excluded(inboxItemsTable.participantId), fromPage: excluded(inboxItemsTable.fromPage) },
          });
          outcome.newMessages = values.filter((row) => !known.has(row.externalId) && !row.fromPage).length;
        }
        messagesOk = true;
      } catch (error) {
        const failure = describeFailure(error, account.id);
        if (failure.error) await noteFailure(account, failure.error);
        outcome.messagesReason = failure.error?.code === "insufficient_permissions" ? permissionReason(failure.error, "messaging (pages_messaging / instagram_business_manage_messages)") : failure.message;
      }
    }

    if (mentions.state === "available") {
      try {
        const found = await fetchMentions(platform, creds);
        const recent = found.filter((mention) => mention.createdAt >= since);
        if (recent.length) {
          const existing = await db.select({ externalId: inboxItemsTable.externalId }).from(inboxItemsTable).where(and(eq(inboxItemsTable.connectedAccountId, account.id), inArray(inboxItemsTable.externalId, recent.map((m) => m.externalId))));
          const known = new Set(existing.map((row) => row.externalId));
          const unique = [...new Map(recent.map((m) => [m.externalId, m])).values()];
          await db.insert(inboxItemsTable).values(unique.map((mention) => ({
            workspaceId: account.workspaceId,
            connectedAccountId: account.id,
            platform,
            kind: "mention" as const,
            externalId: mention.externalId,
            externalPostId: mention.externalId,
            authorName: mention.authorName.slice(0, 300),
            authorAvatar: mention.authorAvatar,
            body: mention.body,
            permalink: mention.permalink,
            createdAtNetwork: mention.createdAt,
          }))).onConflictDoUpdate({
            target: [inboxItemsTable.connectedAccountId, inboxItemsTable.externalId],
            set: { body: excluded(inboxItemsTable.body), authorName: excluded(inboxItemsTable.authorName), authorAvatar: excluded(inboxItemsTable.authorAvatar), permalink: excluded(inboxItemsTable.permalink) },
          });
          outcome.newMentions = unique.filter((m) => !known.has(m.externalId)).length;
        }
        mentionsOk = true;
      } catch (error) {
        const failure = describeFailure(error, account.id);
        if (failure.error) await noteFailure(account, failure.error);
        outcome.mentionsReason = failure.error?.code === "insufficient_permissions" ? permissionReason(failure.error, "mentions (pages_read_engagement / instagram_business_basic)") : failure.message;
      }
    }
  } catch (error) {
    const failure = describeFailure(error, account.id);
    outcome.messagesReason ??= failure.message;
    outcome.mentionsReason ??= failure.message;
  }
  await saveExtrasSync(account.id, { messagesError: outcome.messagesReason, mentionsError: outcome.mentionsReason, messagesOk, mentionsOk }).catch(() => {});
  return outcome;
}

/** Reads one account's comments, and, when MESSAGING_SCOPES_ENABLED=true, its direct messages and mentions. */
export async function collectAccount(account: ConnectedAccount, options: { now?: Date } = {}): Promise<InboxOutcome> {
  const now = options.now ?? new Date();
  const outcome = await collectComments(account, { now });
  const extras = await collectExtras(account, now);
  if (extras) {
    outcome.newMessages = extras.newMessages;
    outcome.newMentions = extras.newMentions;
    outcome.newItems += extras.newMessages + extras.newMentions;
    outcome.messagesReason = extras.messagesReason;
    outcome.mentionsReason = extras.mentionsReason;
  }
  return outcome;
}

export async function collectWorkspace(workspaceId: string, options: { accountIds?: string[] } = {}): Promise<InboxOutcome[]> {
  const accounts = await db
    .select()
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.workspaceId, workspaceId), options.accountIds?.length ? inArray(connectedAccountsTable.id, options.accountIds) : undefined));
  const outcomes: InboxOutcome[] = [];
  for (const account of accounts) outcomes.push(await collectAccount(account));
  return outcomes;
}

let cycleRunning = false;

/** One pass over every active account that can be read. Returns how many new comments arrived. */
export async function runInboxCycle(now = new Date()): Promise<number> {
  if (cycleRunning) return 0;
  cycleRunning = true;
  try {
    const accounts = await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.status, "active"));
    let arrived = 0;
    for (const account of accounts) {
      const worthReading = accountAvailability(account).state === "available" || (messagingScopesEnabled() && (messagingAvailability(account).state === "available" || mentionsAvailability(account).state === "available"));
      if (!worthReading) continue;
      arrived += (await collectAccount(account, { now })).newItems;
    }
    if (arrived > 0) logger.info({ arrived }, "Inbox collected new comments");
    return arrived;
  } finally {
    cycleRunning = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let firstTick: NodeJS.Timeout | null = null;

/** Starts the background collector (every INBOX_POLL_MINUTES, default 10, minimum 1). Off with INBOX_DISABLED=true. */
export function startInbox(): void {
  if (timer || process.env.INBOX_DISABLED === "true") return;
  const minutes = Number(process.env.INBOX_POLL_MINUTES);
  const interval = Math.max(1, Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60_000;
  const tick = () => { runInboxCycle().catch((error) => logger.error({ err: error }, "Inbox cycle failed")); };
  timer = setInterval(tick, interval);
  timer.unref();
  firstTick = setTimeout(tick, 90_000);
  firstTick.unref();
  logger.info({ everyMinutes: interval / 60_000 }, "Inbox collector started");
}

export function stopInbox(): void {
  if (timer) clearInterval(timer);
  if (firstTick) clearTimeout(firstTick);
  timer = null;
  firstTick = null;
}

// ------------------------------------------------------------------------------------------------------- Replies

export type ReplyBlockState = AvailabilityState | "window_closed";

export type ReplyResult =
  | { kind: "not_found" }
  | { kind: "blocked"; state: ReplyBlockState; reason: string }
  | { kind: "sent"; reply: InboxReply }
  | { kind: "failed"; reply: InboxReply; message: string };

/** Time of the person's most recent message in a conversation (the start of the 24-hour window), or null. */
export async function lastInboundAt(connectedAccountId: string, threadId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${inboxItemsTable.createdAtNetwork})`.mapWith(inboxItemsTable.createdAtNetwork) })
    .from(inboxItemsTable)
    .where(and(eq(inboxItemsTable.connectedAccountId, connectedAccountId), eq(inboxItemsTable.threadId, threadId), eq(inboxItemsTable.kind, "message"), eq(inboxItemsTable.fromPage, false)));
  return row?.at ? new Date(row.at) : null;
}

/**
 * Sends a reply to the network, then records it (sent or failed). The item must belong to the workspace. Comments answer under the top-level
 * comment; messages need the 24-hour window to be open (nothing is sent otherwise); mentions are answered as a comment where the network allows.
 */
export async function sendReply(input: { workspaceId: string; userId: string; itemId: string; text: string; now?: Date }): Promise<ReplyResult> {
  const [item] = await db.select().from(inboxItemsTable).where(and(eq(inboxItemsTable.id, input.itemId), eq(inboxItemsTable.workspaceId, input.workspaceId))).limit(1);
  if (!item) return { kind: "not_found" };
  const [account] = await db.select().from(connectedAccountsTable).where(and(eq(connectedAccountsTable.id, item.connectedAccountId), eq(connectedAccountsTable.workspaceId, input.workspaceId))).limit(1);
  if (!account) return { kind: "not_found" };
  const platform = account.platform as Platform;
  const blockedBy = (availability: Availability): ReplyResult | null =>
    availability.state === "available" ? null : { kind: "blocked", state: availability.state, reason: availability.reason ?? "Replies aren't available for this account." };

  let recipientId: string | null = null;
  if (item.kind === "message") {
    const blocked = blockedBy(messagingAvailability(account));
    if (blocked) return blocked;
    if (!item.threadId || !item.participantId) return { kind: "blocked", state: "unavailable", reason: "The network didn't say who this conversation is with, so it can't be answered from here." };
    const window = replyWindow(await lastInboundAt(account.id, item.threadId), input.now);
    if (!window.canReply) return { kind: "blocked", state: "window_closed", reason: WINDOW_CLOSED_MESSAGE };
    recipientId = item.participantId;
  } else if (item.kind === "mention") {
    const mentionReply = mentionReplySupport(platform);
    if (!mentionReply.supported) return { kind: "blocked", state: "unavailable", reason: mentionReply.reason ?? "This mention can't be answered from here." };
    const blocked = blockedBy(mentionsAvailability(account)) ?? blockedBy(accountAvailability(account));
    if (blocked) return blocked;
  } else {
    const blocked = blockedBy(accountAvailability(account));
    if (blocked) return blocked;
  }

  const record = async (values: { status: "sent" | "failed"; error: string | null; externalId: string | null }) => {
    const [reply] = await db.insert(inboxRepliesTable).values({ itemId: item.id, userId: input.userId, body: input.text, ...values }).returning();
    return reply!;
  };
  try {
    const fresh = await ensureFreshToken(account, getAdapter(platform));
    if (fresh.status !== "active") throw new OAuthError("token_expired");
    const creds = inboxCredentials(fresh);
    let externalId: string;
    if (item.kind === "message") {
      externalId = (await sendDirectMessage(platform, creds, { recipientId: recipientId!, text: input.text })).externalId;
    } else if (item.kind === "mention") {
      externalId = (await replyToMention(platform, creds, { externalPostId: item.externalPostId ?? item.externalId, text: input.text })).externalId;
    } else {
      // None of these networks nests deeper than one level, so answering a reply goes under its top-level comment.
      externalId = (await replyToComment(platform, creds, { externalCommentId: item.parentExternalId ?? item.externalId, text: input.text })).externalId;
    }
    const reply = await record({ status: "sent", error: null, externalId });
    if (item.kind === "message" && item.threadId) {
      // The account's own message joins the conversation now; the collector finds the same ID later and leaves it as is.
      await db.insert(inboxItemsTable).values({
        workspaceId: account.workspaceId, connectedAccountId: account.id, platform, kind: "message", externalId, threadId: item.threadId, participantId: item.participantId,
        fromPage: true, authorName: account.displayName.slice(0, 300), body: input.text, createdAtNetwork: new Date(),
      }).onConflictDoNothing();
      await db.update(inboxItemsTable).set({ replied: true, readAt: sql`coalesce(${inboxItemsTable.readAt}, now(3))` }).where(and(eq(inboxItemsTable.connectedAccountId, account.id), eq(inboxItemsTable.threadId, item.threadId), eq(inboxItemsTable.fromPage, false)));
    } else {
      await db.update(inboxItemsTable).set({ replied: true, readAt: item.readAt ?? new Date() }).where(eq(inboxItemsTable.id, item.id));
    }
    return { kind: "sent", reply };
  } catch (error) {
    const failure = describeFailure(error, account.id);
    if (failure.error) await noteFailure(account, failure.error);
    const reply = await record({ status: "failed", error: failure.message, externalId: null });
    return { kind: "failed", reply, message: failure.message };
  }
}

import { and, eq, gt } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, sessionsTable, workspaceMembersTable, type WorkspaceRole } from "@workspace/db";
import { randomToken, sha256 } from "./crypto";

// Authenticated sessions. A session identifies a signed-in user via a
// random token held in a signed, httpOnly, SameSite=Lax cookie; the DB
// stores only the token's SHA-256 hash. Which workspace a session acts on is
// resolved through workspace membership (socialflow_workspace_members), so
// every workspace-scoped route is implicitly authorization-checked by going
// through resolveWorkspace() rather than trusting a workspace ID from the
// client.

export const SESSION_COOKIE = "sf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthContext {
  sessionId: number;
  userId: string;
  /** The workspace the user last switched to, if any. */
  activeWorkspaceId: string | null;
}

export interface WorkspaceContext extends AuthContext {
  workspaceId: string;
  role: WorkspaceRole;
}

function cookieOptions(req: Request, expiresAt: Date) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production" || req.secure,
    signed: true as const,
    expires: expiresAt,
    path: "/",
  };
}

/** Reads the session cookie and returns the authenticated user, or null if
 * not signed in, the session expired, or the cookie was tampered with. */
export async function resolveUser(req: Request): Promise<AuthContext | null> {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || token.length === 0) return null;
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(and(eq(sessionsTable.tokenHash, sha256(token)), gt(sessionsTable.expiresAt, new Date())))
    .limit(1);
  return session ? { sessionId: session.id, userId: session.userId, activeWorkspaceId: session.activeWorkspaceId } : null;
}

/**
 * Resolves the authenticated user and the workspace their session acts on.
 * A user belongs to the workspace created for them at sign-up and to any they were invited to; this returns the one
 * the session switched to (if they're still a member), otherwise their earliest membership, with their role there.
 * Returns null if not signed in.
 */
export async function resolveWorkspace(req: Request, _res: Response): Promise<WorkspaceContext | null> {
  const auth = await resolveUser(req);
  if (!auth) return null;
  const memberships = await db
    .select({ workspaceId: workspaceMembersTable.workspaceId, role: workspaceMembersTable.role })
    .from(workspaceMembersTable)
    .where(eq(workspaceMembersTable.userId, auth.userId))
    .orderBy(workspaceMembersTable.createdAt);
  const membership = memberships.find((row) => row.workspaceId === auth.activeWorkspaceId) ?? memberships[0];
  if (!membership) return null;
  return { ...auth, workspaceId: membership.workspaceId, role: membership.role };
}

/** Creates a new session for `userId` and sets the session cookie. Call
 * after a successful sign-up or sign-in. */
export async function createSession(req: Request, res: Response, userId: string): Promise<void> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessionsTable).values({ tokenHash: sha256(token), userId, expiresAt });
  res.cookie(SESSION_COOKIE, token, cookieOptions(req, expiresAt));
}

/** Deletes the current session row (if any) and clears the cookie. */
export async function clearSession(req: Request, res: Response): Promise<void> {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token.length > 0) {
    await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, sha256(token)));
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

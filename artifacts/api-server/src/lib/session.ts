import { and, eq, gt } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, sessionsTable, workspacesTable } from "@workspace/db";
import { randomToken, sha256 } from "./crypto";

// Minimal workspace session. There is no user login in Socialflow yet, so a
// workspace is created per browser and identified by a random token in a
// signed, httpOnly, SameSite=Lax cookie. The DB stores only the token's hash.
//
// When real authentication is added, replace `resolveWorkspace` so it returns
// the authenticated user's workspace; the OAuth routes only depend on the
// returned { sessionId, workspaceId }.

export const SESSION_COOKIE = "sf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface WorkspaceContext {
  sessionId: number;
  workspaceId: string;
}

export async function resolveWorkspace(
  req: Request,
  res: Response,
  options: { create: boolean },
): Promise<WorkspaceContext | null> {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token.length > 0) {
    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(and(eq(sessionsTable.tokenHash, sha256(token)), gt(sessionsTable.expiresAt, new Date())))
      .limit(1);
    if (session) return { sessionId: session.id, workspaceId: session.workspaceId };
  }
  if (!options.create) return null;

  const newToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const context = await db.transaction(async (tx) => {
    const [workspace] = await tx.insert(workspacesTable).values({}).returning();
    const [session] = await tx
      .insert(sessionsTable)
      .values({ tokenHash: sha256(newToken), workspaceId: workspace!.id, expiresAt })
      .returning();
    return { sessionId: session!.id, workspaceId: workspace!.id };
  });

  res.cookie(SESSION_COOKIE, newToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" || req.secure,
    signed: true,
    expires: expiresAt,
    path: "/",
  });
  return context;
}

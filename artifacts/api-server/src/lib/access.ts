import type { Request, Response } from "express";
import { jsonError } from "./http-errors";
import { can, type Permission } from "./permissions";
import { resolveWorkspace, type WorkspaceContext } from "./session";

/**
 * Resolves the signed-in member and workspace and checks the role may do this. Sends the 401 or 403 itself and returns
 * null, so a route just does `const ctx = await requireAccess(req, res, "posts:write"); if (!ctx) return;`.
 */
export async function requireAccess(req: Request, res: Response, permission: Permission): Promise<WorkspaceContext | null> {
  const ctx = await resolveWorkspace(req, res);
  if (!ctx) {
    jsonError(res, 401, "unauthorized", "Sign in to continue.");
    return null;
  }
  if (!can(ctx.role, permission)) {
    jsonError(res, 403, "forbidden", "Your role in this workspace doesn't allow that. Ask an owner or admin.");
    return null;
  }
  return ctx;
}

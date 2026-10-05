import { auditLogTable, db } from "@workspace/db";
import { logger } from "./logger";

/** Records who did what in a workspace. Never throws: an audit failure must not undo the action it describes. */
export async function recordAudit(entry: { workspaceId: string; actorUserId: string | null; action: string; target?: string | null; detail?: Record<string, unknown> }): Promise<void> {
  try {
    await db.insert(auditLogTable).values({ workspaceId: entry.workspaceId, actorUserId: entry.actorUserId, action: entry.action, target: entry.target ?? null, detail: entry.detail ?? {} });
  } catch (error) {
    logger.warn({ err: error, action: entry.action }, "Recording an audit entry failed");
  }
}

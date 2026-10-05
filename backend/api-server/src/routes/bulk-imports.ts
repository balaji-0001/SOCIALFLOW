import { Router, type IRouter, type Response } from "express";
import { desc, eq } from "drizzle-orm";
import { bulkImportsTable, db, type BulkImport, type BulkImportStatus } from "@workspace/db";
import { requireAccess } from "../lib/access";
import { recordAudit } from "../lib/audit";
import { BulkImportError, commitImport, parseImportRequest, serializePreviewRow, validateImport } from "../lib/bulk-import";
import { jsonError } from "../lib/http-errors";
import { rateLimit } from "../middlewares/rate-limit";

/*
 * CSV bulk import (lib/bulk-import.ts). Preview validates without saving anything; the import re-validates on the
 * server and creates the valid rows. Both need posts:write (the same as creating a post); the history needs posts:read.
 */

const router: IRouter = Router();

const previewLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: Number(process.env.BULK_IMPORT_PREVIEW_RATE_LIMIT ?? 60), keyPrefix: "bulk-import:preview" });
const importLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: Number(process.env.BULK_IMPORT_RATE_LIMIT ?? 10), keyPrefix: "bulk-import:commit" });

function sendImportError(res: Response, error: unknown): boolean {
  if (error instanceof BulkImportError) {
    jsonError(res, error.status, error.code, error.message);
    return true;
  }
  return false;
}

const serializeImport = (row: BulkImport) => ({
  id: row.id, fileName: row.fileName, totalRows: row.totalRows, createdCount: row.createdCount, failedCount: row.failedCount,
  status: row.status, mode: row.mode, errors: row.errors, createdByUserId: row.createdByUserId, createdAt: row.createdAt,
});

router.post("/bulk-imports/preview", previewLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "posts:write");
  if (!ctx) return;
  try {
    const request = parseImportRequest(req.body);
    const validation = await validateImport(ctx.workspaceId, request);
    const errorCount = validation.rows.filter((row) => row.errors.length > 0).length;
    res.json({ rows: validation.rows.map(serializePreviewRow), totalRows: validation.rows.length, validCount: validation.rows.length - errorCount, errorCount, warnings: validation.warnings });
  } catch (error) {
    if (sendImportError(res, error)) return;
    throw error;
  }
});

router.post("/bulk-imports", importLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "posts:write");
  if (!ctx) return;
  try {
    const request = parseImportRequest(req.body);
    // Never trust the preview: the file is validated again here, against the workspace as it is now.
    const validation = await validateImport(ctx.workspaceId, request);
    const outcome = await commitImport(ctx.workspaceId, ctx.userId, validation, request.mode);
    const status: BulkImportStatus = outcome.failed === 0 ? "completed" : outcome.created > 0 ? "partial" : "failed";
    const [saved] = await db.insert(bulkImportsTable).values({
      workspaceId: ctx.workspaceId, createdByUserId: ctx.userId, fileName: request.fileName, totalRows: validation.rows.length,
      createdCount: outcome.created, failedCount: outcome.failed, status, mode: request.mode, errors: outcome.errors,
    }).returning();
    await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "bulk_import.complete", target: saved!.id, detail: { fileName: request.fileName, mode: request.mode, created: outcome.created, failed: outcome.failed } });
    req.log.info({ importId: saved!.id, created: outcome.created, failed: outcome.failed }, "CSV import finished");
    res.status(201).json({ importId: saved!.id, status, totalRows: validation.rows.length, created: outcome.created, failed: outcome.failed, errors: outcome.errors, postIds: outcome.postIds });
  } catch (error) {
    if (sendImportError(res, error)) return;
    throw error;
  }
});

router.get("/bulk-imports", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "posts:read");
  if (!ctx) return;
  const rows = await db.select().from(bulkImportsTable).where(eq(bulkImportsTable.workspaceId, ctx.workspaceId)).orderBy(desc(bulkImportsTable.createdAt)).limit(20);
  res.json({ imports: rows.map(serializeImport) });
});

export default router;

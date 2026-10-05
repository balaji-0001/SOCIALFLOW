import { and, asc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { alphabetical, db } from "@workspace/db";
import { brandVoicesTable, type BrandVoice } from "@workspace/db";
import {
  AiError, AI_PLATFORMS, AI_TASKS, MAX_VARIATIONS, NOT_CONFIGURED_REASON, PLATFORM_LIMITS, YOUTUBE_TITLE_LIMIT,
  buildSystemPrompt, buildUserPrompt, callAnthropic, getAiConfig, loadVoice, maxTokensFor, parseGenerateInput, parseOutputs,
  recordUsage, requireAiAccess, usageToday,
} from "../lib/ai";
import { recordAudit } from "../lib/audit";
import { jsonError } from "../lib/http-errors";
import { rateLimit } from "../middlewares/rate-limit";

/* AI Studio: status, generation, brand voices and usage. */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const generateLimiter = rateLimit({ windowMs: 60_000, max: Number(process.env.AI_RATE_LIMIT ?? 20), keyPrefix: "ai:generate" });

const serializeVoice = (v: BrandVoice) => ({
  id: v.id, name: v.name, description: v.description, toneNotes: v.toneNotes, doWords: v.doWords, dontWords: v.dontWords,
  updatedBy: v.updatedBy, createdAt: v.createdAt, updatedAt: v.updatedAt,
});

router.get("/ai/status", async (req, res): Promise<void> => {
  const ctx = await requireAiAccess(req, res, "ai:read");
  if (!ctx) return;
  const config = getAiConfig();
  res.json({
    available: config.apiKey !== null,
    reason: config.apiKey ? null : NOT_CONFIGURED_REASON,
    model: config.apiKey ? config.model : null,
    dailyLimit: config.dailyLimit,
    tasks: [...AI_TASKS],
    maxVariations: MAX_VARIATIONS,
    platforms: AI_PLATFORMS.map((p) => ({ platform: p, characterLimit: PLATFORM_LIMITS[p].hard, suggestedLength: PLATFORM_LIMITS[p].suggested, titleLimit: p === "youtube" ? YOUTUBE_TITLE_LIMIT : null })),
  });
});

router.get("/ai/usage", async (req, res): Promise<void> => {
  const ctx = await requireAiAccess(req, res, "ai:read");
  if (!ctx) return;
  res.json(await usageToday(ctx.workspaceId));
});

router.post("/ai/generate", generateLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAiAccess(req, res, "ai:use");
  if (!ctx) return;
  const config = getAiConfig();
  if (!config.apiKey) {
    res.status(503).json({ error: "ai_not_configured", code: "ai_not_configured", message: NOT_CONFIGURED_REASON });
    return;
  }
  const input = parseGenerateInput(req.body);
  if (typeof input === "string") { jsonError(res, 400, "invalid_request", input); return; }

  let voice: BrandVoice | null = null;
  const voiceId = (req.body as { brandVoiceId?: unknown }).brandVoiceId;
  if (voiceId !== undefined && voiceId !== null) {
    if (typeof voiceId !== "string" || !UUID.test(voiceId)) { jsonError(res, 400, "invalid_request", "brandVoiceId is not valid."); return; }
    voice = await loadVoice(ctx.workspaceId, voiceId);
    if (!voice) { jsonError(res, 404, "not_found", "That brand voice doesn't exist in this workspace."); return; }
  }

  const usage = await usageToday(ctx.workspaceId, config);
  if (usage.requests >= config.dailyLimit) {
    res.status(429).json({ error: "ai_daily_limit", code: "ai_daily_limit", message: `This workspace has used its ${config.dailyLimit} AI requests for today. The limit resets at ${usage.resetsAt}.`, limit: config.dailyLimit, resetsAt: usage.resetsAt });
    return;
  }

  try {
    const result = await callAnthropic(config, buildSystemPrompt(voice, input), buildUserPrompt(input), maxTokensFor(input));
    const outputs = parseOutputs(result.text, input);
    if (outputs.length === 0) throw new AiError(502, "ai_bad_output", "The AI's answer couldn't be read. Try again.");
    await recordUsage({ workspaceId: ctx.workspaceId, userId: ctx.userId, task: input.task, result });
    res.json({
      task: input.task,
      model: result.model,
      brandVoiceId: voice?.id ?? null,
      outputs,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      remainingToday: Math.max(0, config.dailyLimit - usage.requests - 1),
    });
  } catch (error) {
    if (error instanceof AiError) {
      res.status(error.status).json({ error: error.code, code: error.code, message: error.message });
      return;
    }
    throw error;
  }
});

/* ---- brand voices ---- */

type VoiceFields = { name: string; description: string; toneNotes: string; doWords: string[]; dontWords: string[] };

function parseWords(value: unknown, field: string): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) return `${field} must be a list of up to 50 words or phrases.`;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return `${field} must contain only text.`;
    const w = item.trim();
    if (!w) continue;
    if (w.length > 60) return `Each entry in ${field} can be up to 60 characters.`;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function parseVoice(body: unknown): VoiceFields | string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 80) return "name is required (up to 80 characters).";
  const description = typeof b.description === "string" ? b.description.trim() : "";
  const toneNotes = typeof b.toneNotes === "string" ? b.toneNotes.trim() : "";
  if (description.length > 1000) return "description can be up to 1000 characters.";
  if (toneNotes.length > 1000) return "toneNotes can be up to 1000 characters.";
  const doWords = parseWords(b.doWords, "doWords");
  if (typeof doWords === "string") return doWords;
  const dontWords = parseWords(b.dontWords, "dontWords");
  if (typeof dontWords === "string") return dontWords;
  return { name, description, toneNotes, doWords, dontWords };
}

router.get("/ai/brand-voices", async (req, res): Promise<void> => {
  const ctx = await requireAiAccess(req, res, "ai:read");
  if (!ctx) return;
  const rows = await db.select().from(brandVoicesTable).where(eq(brandVoicesTable.workspaceId, ctx.workspaceId)).orderBy(alphabetical(brandVoicesTable.name), asc(brandVoicesTable.name));
  res.json({ voices: rows.map(serializeVoice) });
});

router.post("/ai/brand-voices", async (req, res): Promise<void> => {
  const ctx = await requireAiAccess(req, res, "ai:manage");
  if (!ctx) return;
  const fields = parseVoice(req.body);
  if (typeof fields === "string") { jsonError(res, 400, "invalid_request", fields); return; }
  const [row] = await db.insert(brandVoicesTable).values({ ...fields, workspaceId: ctx.workspaceId, updatedBy: ctx.userId }).returning();
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "ai.brand_voice.created", target: row!.id, detail: { name: fields.name } });
  res.status(201).json(serializeVoice(row!));
});

router.put("/ai/brand-voices/:id", async (req, res): Promise<void> => {
  const ctx = await requireAiAccess(req, res, "ai:manage");
  if (!ctx) return;
  const id = String(req.params.id);
  if (!UUID.test(id)) { jsonError(res, 404, "not_found", "Brand voice not found."); return; }
  const fields = parseVoice(req.body);
  if (typeof fields === "string") { jsonError(res, 400, "invalid_request", fields); return; }
  const [row] = await db.update(brandVoicesTable).set({ ...fields, updatedBy: ctx.userId, updatedAt: new Date() })
    .where(and(eq(brandVoicesTable.id, id), eq(brandVoicesTable.workspaceId, ctx.workspaceId))).returning();
  if (!row) { jsonError(res, 404, "not_found", "Brand voice not found."); return; }
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "ai.brand_voice.updated", target: row.id, detail: { name: fields.name } });
  res.json(serializeVoice(row));
});

router.delete("/ai/brand-voices/:id", async (req, res): Promise<void> => {
  const ctx = await requireAiAccess(req, res, "ai:manage");
  if (!ctx) return;
  const id = String(req.params.id);
  if (!UUID.test(id)) { jsonError(res, 404, "not_found", "Brand voice not found."); return; }
  const [row] = await db.delete(brandVoicesTable).where(and(eq(brandVoicesTable.id, id), eq(brandVoicesTable.workspaceId, ctx.workspaceId))).returning();
  if (!row) { jsonError(res, 404, "not_found", "Brand voice not found."); return; }
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "ai.brand_voice.deleted", target: row.id, detail: { name: row.name } });
  res.status(204).end();
});

export default router;

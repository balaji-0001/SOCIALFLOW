import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

// A workspace's brand voice: injected into the AI system prompt when selected.
export const brandVoicesTable = pgTable(
  "socialflow_brand_voices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    toneNotes: text("tone_notes").notNull().default(""),
    doWords: text("do_words").array().notNull().default([]),
    dontWords: text("dont_words").array().notNull().default([]),
    updatedBy: uuid("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("socialflow_brand_voices_workspace_idx").on(table.workspaceId)],
);

// One row per successful AI call, with the token counts the API reported. Counted for the daily limit.
export const aiUsageTable = pgTable(
  "socialflow_ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    task: text("task").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("socialflow_ai_usage_workspace_idx").on(table.workspaceId, table.createdAt)],
);

export type BrandVoice = typeof brandVoicesTable.$inferSelect;
export type AiUsage = typeof aiUsageTable.$inferSelect;

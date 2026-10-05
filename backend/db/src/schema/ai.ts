import { index, int, mediumtext, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

// A workspace's brand voice: injected into the AI system prompt when selected.
export const brandVoicesTable = mysqlTable(
  "socialflow_brand_voices",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    name: mediumtext("name").notNull(),
    description: mediumtext("description").notNull().default(""),
    toneNotes: mediumtext("tone_notes").notNull().default(""),
    doWords: json("do_words").$type<string[]>().notNull().$defaultFn(() => []),
    dontWords: json("dont_words").$type<string[]>().notNull().$defaultFn(() => []),
    updatedBy: uuid("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("socialflow_brand_voices_workspace_idx").on(table.workspaceId)],
);

// One row per successful AI call, with the token counts the API reported. Counted for the daily limit.
export const aiUsageTable = mysqlTable(
  "socialflow_ai_usage",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    task: varchar("task", { length: 255 }).notNull(),
    inputTokens: int("input_tokens").notNull().default(0),
    outputTokens: int("output_tokens").notNull().default(0),
    model: mediumtext("model").notNull(),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("socialflow_ai_usage_workspace_idx").on(table.workspaceId, table.createdAt)],
);

export type BrandVoice = typeof brandVoicesTable.$inferSelect;
export type AiUsage = typeof aiUsageTable.$inferSelect;

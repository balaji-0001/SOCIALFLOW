import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { postsTable } from "./posts";
import { workspacesTable } from "./workspaces";

export const customFieldTypes = ["text", "number", "date", "select", "url"] as const;
export type CustomFieldType = (typeof customFieldTypes)[number];

// Workspace-defined extra fields on posts (e.g. "Client", "Campaign code").
// The definition lives here; each post stores one value per field.
export const customFieldsTable = pgTable(
  "socialflow_custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").$type<CustomFieldType>().notNull(),
    // Choices for `select` fields.
    options: jsonb("options").$type<string[]>().notNull().default([]),
    required: boolean("required").notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("socialflow_custom_fields_unique").on(table.workspaceId, table.key)],
);

export const postCustomValuesTable = pgTable(
  "socialflow_post_custom_values",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFieldsTable.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.fieldId] })],
);

export type CustomField = typeof customFieldsTable.$inferSelect;

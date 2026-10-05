import { boolean, int, mediumtext, mysqlTable, primaryKey, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
import { postsTable } from "./posts";
import { workspacesTable } from "./workspaces";

export const customFieldTypes = ["text", "number", "date", "select", "url"] as const;
export type CustomFieldType = (typeof customFieldTypes)[number];

// Workspace-defined extra fields on posts (e.g. "Client", "Campaign code").
// The definition lives here; each post stores one value per field.
export const customFieldsTable = mysqlTable(
  "socialflow_custom_fields",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 191 }).notNull(),
    label: mediumtext("label").notNull(),
    type: varchar("type", { length: 64 }).$type<CustomFieldType>().notNull(),
    // Choices for `select` fields.
    options: json("options").$type<string[]>().notNull().$defaultFn(() => []),
    required: boolean("required").notNull().default(false),
    position: int("position").notNull().default(0),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("socialflow_custom_fields_unique").on(table.workspaceId, table.key)],
);

export const postCustomValuesTable = mysqlTable(
  "socialflow_post_custom_values",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFieldsTable.id, { onDelete: "cascade" }),
    value: mediumtext("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.fieldId] })],
);

export type CustomField = typeof customFieldsTable.$inferSelect;

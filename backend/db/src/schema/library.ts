import { boolean, index, int, mediumtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
import { sql } from "drizzle-orm";
import { mediaTable } from "./media";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const libraryKinds = ["media", "caption", "template", "snippet"] as const;
export type LibraryKind = (typeof libraryKinds)[number];

// Flat folders (no nesting), unique per workspace by lower(name). MySQL keeps lower(name) in name_key itself (a
// generated column), which is what the unique key is on.
export const libraryFoldersTable = mysqlTable(
  "socialflow_library_folders",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    nameKey: varchar("name_key", { length: 255 }).generatedAlwaysAs(sql`lower(name)`, { mode: "stored" }),
  },
  (table) => [uniqueIndex("socialflow_library_folders_name_unique").on(table.workspaceId, table.nameKey)],
);

// Reusable content. A 'media' item REFERENCES an existing socialflow_media row; it never copies the file.
// Labels are a text[] column (the tags system is post-specific: socialflow_post_tags), see docs/integration/library.md.
export const libraryItemsTable = mysqlTable(
  "socialflow_library_items",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 64 }).$type<LibraryKind>().notNull(),
    title: mediumtext("title").notNull(),
    body: mediumtext("body"),
    mediaId: uuid("media_id").references(() => mediaTable.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => libraryFoldersTable.id, { onDelete: "set null" }),
    labels: json("labels").$type<string[]>().notNull().$defaultFn(() => []),
    favorite: boolean("favorite").notNull().default(false),
    useCount: int("use_count").notNull().default(0),
    lastUsedAt: timestamptz("last_used_at"),
    createdBy: uuid("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("socialflow_library_items_ws_idx").on(table.workspaceId, table.createdAt),
    index("socialflow_library_items_media_idx").on(table.mediaId),
  ],
);

export type LibraryItem = typeof libraryItemsTable.$inferSelect;
export type LibraryFolder = typeof libraryFoldersTable.$inferSelect;

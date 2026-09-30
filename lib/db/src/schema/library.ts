import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { mediaTable } from "./media";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const libraryKinds = ["media", "caption", "template", "snippet"] as const;
export type LibraryKind = (typeof libraryKinds)[number];

// Flat folders (no nesting), unique per workspace by lower(name).
export const libraryFoldersTable = pgTable(
  "socialflow_library_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("socialflow_library_folders_name_unique").on(table.workspaceId, sql`lower(${table.name})`)],
);

// Reusable content. A 'media' item REFERENCES an existing socialflow_media row; it never copies the file.
// Labels are a text[] column (the tags system is post-specific: socialflow_post_tags), see docs/integration/library.md.
export const libraryItemsTable = pgTable(
  "socialflow_library_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<LibraryKind>().notNull(),
    title: text("title").notNull(),
    body: text("body"),
    mediaId: uuid("media_id").references(() => mediaTable.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => libraryFoldersTable.id, { onDelete: "set null" }),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    favorite: boolean("favorite").notNull().default(false),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("socialflow_library_items_ws_idx").on(table.workspaceId, table.createdAt),
    index("socialflow_library_items_media_idx").on(table.mediaId),
  ],
);

export type LibraryItem = typeof libraryItemsTable.$inferSelect;
export type LibraryFolder = typeof libraryFoldersTable.$inferSelect;

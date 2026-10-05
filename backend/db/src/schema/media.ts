import { index, int, mediumtext, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { postsTable } from "./posts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const mediaKinds = ["image", "video"] as const;
export type MediaKind = (typeof mediaKinds)[number];

// An uploaded image or video. The bytes live in the media storage directory
// (see api-server/src/lib/media.ts); this row is the record of them. A file
// uploaded in the composer exists before the post does, so rows can be
// unattached for a while and are swept if they never get attached.
export const mediaTable = mysqlTable(
  "socialflow_media",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    kind: varchar("kind", { length: 64 }).$type<MediaKind>().notNull(),
    // Detected from the file's own bytes, never trusted from the client.
    mimeType: mediumtext("mime_type").notNull(),
    originalName: mediumtext("original_name").notNull(),
    sizeBytes: int("size_bytes").notNull(),
    // Relative path inside the storage directory.
    storageKey: mediumtext("storage_key").notNull(),
    // Display metadata measured by the uploading browser; used for layout only.
    width: int("width"),
    height: int("height"),
    durationMs: int("duration_ms"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("socialflow_media_workspace_idx").on(table.workspaceId, table.createdAt)],
);

// Which media a post carries, in display order.
export const postMediaTable = mysqlTable(
  "socialflow_post_media",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaTable.id, { onDelete: "cascade" }),
    position: int("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.mediaId] }),
    index("socialflow_post_media_media_idx").on(table.mediaId),
  ],
);

export type Media = typeof mediaTable.$inferSelect;

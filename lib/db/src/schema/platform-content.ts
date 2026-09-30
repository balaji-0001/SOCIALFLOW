import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { postsTable } from "./posts";

// A network-specific version of a post's text. No row for a platform means
// the post's base `content` is what that network receives.
export const postPlatformContentTable = pgTable(
  "socialflow_post_platform_content",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    content: text("content").notNull(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.platform] })],
);

export type PostPlatformContent = typeof postPlatformContentTable.$inferSelect;

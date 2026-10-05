import { mediumtext, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";
import { uuid } from "./_columns";
import { postsTable } from "./posts";

// A network-specific version of a post's text. No row for a platform means
// the post's base `content` is what that network receives.
export const postPlatformContentTable = mysqlTable(
  "socialflow_post_platform_content",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 64 }).notNull(),
    content: mediumtext("content").notNull(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.platform] })],
);

export type PostPlatformContent = typeof postPlatformContentTable.$inferSelect;

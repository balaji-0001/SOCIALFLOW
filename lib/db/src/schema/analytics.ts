import { bigint, index, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { connectedAccountsTable } from "./connected-accounts";
import { postTargetsTable } from "./posts";

// A reading of an account's size at a moment. Any column is null when the network doesn't report it for this account.
export const accountMetricsTable = pgTable(
  "socialflow_account_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectedAccountId: uuid("connected_account_id")
      .notNull()
      .references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    followers: integer("followers"),
    mediaCount: integer("media_count"),
    viewsTotal: bigint("views_total", { mode: "number" }),
  },
  (table) => [index("socialflow_account_metrics_idx").on(table.connectedAccountId, table.capturedAt)],
);

// A reading of one published post's numbers at a moment (cumulative, as the network reports them).
export const postMetricsTable = pgTable(
  "socialflow_post_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postTargetId: uuid("post_target_id")
      .notNull()
      .references(() => postTargetsTable.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    views: bigint("views", { mode: "number" }),
    impressions: bigint("impressions", { mode: "number" }),
    reach: bigint("reach", { mode: "number" }),
    saves: integer("saves"),
  },
  (table) => [index("socialflow_post_metrics_idx").on(table.postTargetId, table.capturedAt)],
);

export type AccountMetric = typeof accountMetricsTable.$inferSelect;
export type PostMetric = typeof postMetricsTable.$inferSelect;

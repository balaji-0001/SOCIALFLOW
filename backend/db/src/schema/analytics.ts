import { bigint, index, int, mysqlTable } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { connectedAccountsTable } from "./connected-accounts";
import { postTargetsTable } from "./posts";

// A reading of an account's size at a moment. Any column is null when the network doesn't report it for this account.
export const accountMetricsTable = mysqlTable(
  "socialflow_account_metrics",
  {
    id: uuidPk("id"),
    connectedAccountId: uuid("connected_account_id")
      .notNull()
      .references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
    capturedAt: timestamptz("captured_at").notNull().$defaultFn(() => new Date()),
    followers: int("followers"),
    mediaCount: int("media_count"),
    viewsTotal: bigint("views_total", { mode: "number" }),
  },
  (table) => [index("socialflow_account_metrics_idx").on(table.connectedAccountId, table.capturedAt)],
);

// A reading of one published post's numbers at a moment (cumulative, as the network reports them).
export const postMetricsTable = mysqlTable(
  "socialflow_post_metrics",
  {
    id: uuidPk("id"),
    postTargetId: uuid("post_target_id")
      .notNull()
      .references(() => postTargetsTable.id, { onDelete: "cascade" }),
    capturedAt: timestamptz("captured_at").notNull().$defaultFn(() => new Date()),
    likes: int("likes"),
    comments: int("comments"),
    shares: int("shares"),
    views: bigint("views", { mode: "number" }),
    impressions: bigint("impressions", { mode: "number" }),
    reach: bigint("reach", { mode: "number" }),
    saves: int("saves"),
  },
  (table) => [index("socialflow_post_metrics_idx").on(table.postTargetId, table.capturedAt)],
);

export type AccountMetric = typeof accountMetricsTable.$inferSelect;
export type PostMetric = typeof postMetricsTable.$inferSelect;

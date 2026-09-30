/* Inbox direct messages and mentions. Additive only: every new column is nullable or has a default, existing rows become kind='comment'. */
export const inboxDmMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0015_inbox_messages_mentions",
    sql: `
      alter table socialflow_inbox_items add column if not exists kind text not null default 'comment' check (kind in ('comment', 'message', 'mention'));
      alter table socialflow_inbox_items add column if not exists thread_id text;
      alter table socialflow_inbox_items add column if not exists participant_id text;
      alter table socialflow_inbox_items add column if not exists from_page boolean not null default false;
      alter table socialflow_inbox_items add column if not exists permalink text;
      create index if not exists socialflow_inbox_items_kind_idx on socialflow_inbox_items (workspace_id, kind, status, created_at_network);
      create index if not exists socialflow_inbox_items_thread_idx on socialflow_inbox_items (connected_account_id, thread_id, created_at_network);
      alter table socialflow_inbox_sync add column if not exists messages_error text;
      alter table socialflow_inbox_sync add column if not exists mentions_error text;
      alter table socialflow_inbox_sync add column if not exists messages_synced_at timestamptz;
      alter table socialflow_inbox_sync add column if not exists mentions_synced_at timestamptz;
    `,
  },
];

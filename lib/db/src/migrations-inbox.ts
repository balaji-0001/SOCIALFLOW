/* Inbox tables. Additive only; the integrator appends this list to `migrations` in migrations.ts. */
export const inboxMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0012_inbox",
    sql: `
      create table if not exists socialflow_inbox_items (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        connected_account_id uuid not null references socialflow_connected_accounts(id) on delete cascade,
        post_target_id uuid references socialflow_post_targets(id) on delete set null,
        platform text not null,
        external_id text not null,
        external_post_id text,
        parent_external_id text,
        author_name text not null,
        author_avatar text,
        body text not null,
        created_at_network timestamptz not null,
        status text not null default 'open',
        read_at timestamptz,
        assigned_to_user_id uuid references socialflow_users(id) on delete set null,
        replied boolean not null default false,
        created_at timestamptz not null default now()
      );
      create unique index if not exists socialflow_inbox_items_external_idx on socialflow_inbox_items (connected_account_id, external_id);
      create index if not exists socialflow_inbox_items_list_idx on socialflow_inbox_items (workspace_id, status, created_at_network);
      create table if not exists socialflow_inbox_replies (
        id uuid primary key default gen_random_uuid(),
        item_id uuid not null references socialflow_inbox_items(id) on delete cascade,
        user_id uuid references socialflow_users(id) on delete set null,
        body text not null,
        status text not null,
        error text,
        external_id text,
        created_at timestamptz not null default now()
      );
      create index if not exists socialflow_inbox_replies_item_idx on socialflow_inbox_replies (item_id, created_at);
      create table if not exists socialflow_inbox_sync (
        connected_account_id uuid primary key references socialflow_connected_accounts(id) on delete cascade,
        last_synced_at timestamptz,
        last_error text,
        posts_read integer not null default 0
      );
    `,
  },
];

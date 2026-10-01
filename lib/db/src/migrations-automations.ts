/**
 * Automations (WordPress auto-share and RSS/Atom feeds) and the CSV bulk import history. Additive only.
 * The unique (automation_id, item_key) index is the duplicate protection: a feed item becomes at most one post.
 */
export const automationsMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0019_automations",
    sql: `
      create table if not exists socialflow_automations (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        kind text not null check (kind in ('wordpress','rss')),
        name text not null,
        source_url text not null,
        status text not null default 'active' check (status in ('active','paused','error')),
        config jsonb not null default '{}'::jsonb,
        last_run_at timestamptz,
        next_run_at timestamptz,
        last_status text,
        last_error text,
        consecutive_failures integer not null default 0,
        baseline_at timestamptz,
        created_by_user_id uuid references socialflow_users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists socialflow_automations_workspace_idx on socialflow_automations (workspace_id);
      create index if not exists socialflow_automations_due_idx on socialflow_automations (status, next_run_at);

      create table if not exists socialflow_automation_items (
        id uuid primary key default gen_random_uuid(),
        automation_id uuid not null references socialflow_automations(id) on delete cascade,
        item_key text not null,
        title text,
        url text,
        published_at timestamptz,
        status text not null check (status in ('pending','posted','skipped','failed','seen')),
        post_id uuid references socialflow_posts(id) on delete set null,
        attempts integer not null default 0,
        error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (automation_id, item_key)
      );
      create index if not exists socialflow_automation_items_recent_idx on socialflow_automation_items (automation_id, created_at);

      create table if not exists socialflow_automation_runs (
        id uuid primary key default gen_random_uuid(),
        automation_id uuid not null references socialflow_automations(id) on delete cascade,
        started_at timestamptz not null default now(),
        finished_at timestamptz,
        status text not null check (status in ('success','no_new','partial','failed')),
        items_found integer not null default 0,
        items_new integer not null default 0,
        posts_created integer not null default 0,
        error text
      );
      create index if not exists socialflow_automation_runs_idx on socialflow_automation_runs (automation_id, started_at);

      create table if not exists socialflow_bulk_imports (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        created_by_user_id uuid references socialflow_users(id) on delete set null,
        file_name text not null,
        total_rows integer not null default 0,
        created_count integer not null default 0,
        failed_count integer not null default 0,
        status text not null check (status in ('completed','partial','failed')),
        mode text not null,
        errors jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists socialflow_bulk_imports_workspace_idx on socialflow_bulk_imports (workspace_id, created_at);
    `,
  },
];

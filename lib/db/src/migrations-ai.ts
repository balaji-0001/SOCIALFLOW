// AI Studio tables. Additive only; the integrator spreads this into `migrations` (see docs/integration/ai.md).
export const aiMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0013_ai_studio",
    sql: `
      create table if not exists socialflow_brand_voices (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        name text not null,
        description text not null default '',
        tone_notes text not null default '',
        do_words text[] not null default '{}',
        dont_words text[] not null default '{}',
        updated_by uuid references socialflow_users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists socialflow_brand_voices_workspace_idx on socialflow_brand_voices (workspace_id);
      create table if not exists socialflow_ai_usage (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        user_id uuid references socialflow_users(id) on delete set null,
        task text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        model text not null,
        created_at timestamptz not null default now()
      );
      create index if not exists socialflow_ai_usage_workspace_idx on socialflow_ai_usage (workspace_id, created_at);
    `,
  },
];

/* Approvals workflow tables. Additive only. */
export const approvalsMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0011_approvals",
    sql: `
      create table if not exists socialflow_approval_settings (
        workspace_id uuid primary key references socialflow_workspaces(id) on delete cascade,
        required boolean not null default false,
        updated_by uuid references socialflow_users(id) on delete set null,
        updated_at timestamptz not null default now()
      );
      create table if not exists socialflow_post_approvals (
        id uuid primary key default gen_random_uuid(),
        post_id uuid not null references socialflow_posts(id) on delete cascade,
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        status text not null default 'pending',
        requested_by uuid references socialflow_users(id) on delete set null,
        requested_at timestamptz not null default now(),
        decided_by uuid references socialflow_users(id) on delete set null,
        decided_at timestamptz,
        note text
      );
      create unique index if not exists socialflow_post_approvals_post_idx on socialflow_post_approvals (post_id);
      create index if not exists socialflow_post_approvals_ws_status_idx on socialflow_post_approvals (workspace_id, status);
      create table if not exists socialflow_post_approval_comments (
        id uuid primary key default gen_random_uuid(),
        approval_id uuid not null references socialflow_post_approvals(id) on delete cascade,
        user_id uuid references socialflow_users(id) on delete set null,
        body text not null,
        created_at timestamptz not null default now()
      );
      create index if not exists socialflow_post_approval_comments_idx on socialflow_post_approval_comments (approval_id, created_at);
    `,
  },
];

// Scheduled analytics reports. Additive only; the integrator spreads this into `migrations` (see docs/integration/reports.md).
export const reportsMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0016_reports",
    sql: `
      create table if not exists socialflow_report_schedules (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        created_by uuid references socialflow_users(id) on delete set null,
        name text not null,
        frequency text not null check (frequency in ('weekly','monthly')),
        weekday integer check (weekday between 0 and 6),
        day_of_month integer check (day_of_month between 1 and 28),
        hour integer not null check (hour between 0 and 23),
        timezone text not null default 'UTC',
        range_key text not null default '7d' check (range_key in ('7d','30d','90d')),
        platform text,
        account_id uuid references socialflow_connected_accounts(id) on delete cascade,
        recipients text[] not null default '{}',
        enabled boolean not null default true,
        last_run_at timestamptz,
        last_status text,
        last_error text,
        next_run_at timestamptz,
        created_at timestamptz not null default now()
      );
      create index if not exists socialflow_report_schedules_workspace_idx on socialflow_report_schedules (workspace_id);
      create index if not exists socialflow_report_schedules_due_idx on socialflow_report_schedules (next_run_at);
      create table if not exists socialflow_report_runs (
        id uuid primary key default gen_random_uuid(),
        schedule_id uuid not null references socialflow_report_schedules(id) on delete cascade,
        ran_at timestamptz not null default now(),
        status text not null check (status in ('sent','failed')),
        error text,
        recipient_count integer not null default 0
      );
      create index if not exists socialflow_report_runs_schedule_idx on socialflow_report_runs (schedule_id, ran_at);
    `,
  },
];

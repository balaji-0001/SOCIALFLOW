/** Requests received from Meta's "data deletion callback" (someone removed the app in Facebook or Instagram). Additive. */
export const dataDeletionMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0018_data_deletions",
    sql: `
      create table if not exists socialflow_data_deletions (
        id uuid primary key default gen_random_uuid(),
        confirmation_code text not null unique,
        platform text not null,
        external_user_id text not null,
        accounts_removed integer not null default 0,
        status text not null default 'completed',
        requested_at timestamptz not null default now(),
        completed_at timestamptz
      );
      create index if not exists socialflow_data_deletions_user_idx on socialflow_data_deletions (platform, external_user_id);
    `,
  },
];

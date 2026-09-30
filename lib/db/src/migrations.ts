import { linkMigrations } from "./migrations-link";
import { inboxDmMigrations } from "./migrations-inbox-dm";
import { reportsMigrations } from "./migrations-reports";
import { approvalsMigrations } from "./migrations-approvals";
import { inboxMigrations } from "./migrations-inbox";
import { aiMigrations } from "./migrations-ai";
import { libraryMigrations } from "./migrations-library";
/*
 * Schema migrations, applied in order by `runMigrations()` (lib/db/src/migrate.ts) when the API starts and before
 * the test suite runs. Each entry runs once per database; applied names are recorded in `socialflow_migrations`.
 *
 * Rules: additive only (new tables, new nullable columns, new indexes). Never drop or rewrite existing data.
 * The Drizzle schema files in ./schema describe the same tables for the ORM; keep the two in step.
 */
export const migrations: Array<{ name: string; sql: string }> = [
  {
    name: "0001_password_resets",
    sql: `
      create table if not exists socialflow_password_resets (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references socialflow_users(id) on delete cascade,
        token_hash text not null unique,
        expires_at timestamptz not null,
        used_at timestamptz,
        created_at timestamptz not null default now()
      );
      create index if not exists socialflow_password_resets_user_idx on socialflow_password_resets (user_id);
    `,
  },
  {
    name: "0002_post_platform_content",
    sql: `
      -- Per-network text. Absent row = the post's base content is used for that network.
      create table if not exists socialflow_post_platform_content (
        post_id uuid not null references socialflow_posts(id) on delete cascade,
        platform text not null,
        content text not null,
        primary key (post_id, platform)
      );
    `,
  },
  {
    name: "0003_queues",
    sql: `
      create table if not exists socialflow_account_queues (
        connected_account_id uuid primary key references socialflow_connected_accounts(id) on delete cascade,
        timezone text not null,
        paused boolean not null default false,
        updated_at timestamptz not null default now()
      );
      create table if not exists socialflow_queue_slots (
        id uuid primary key default gen_random_uuid(),
        connected_account_id uuid not null references socialflow_connected_accounts(id) on delete cascade,
        weekday smallint not null check (weekday between 0 and 6),
        minute_of_day smallint not null check (minute_of_day between 0 and 1439),
        unique (connected_account_id, weekday, minute_of_day)
      );
      create index if not exists socialflow_queue_slots_account_idx on socialflow_queue_slots (connected_account_id);
    `,
  },
  {
    name: "0004_recurrences",
    sql: `
      create table if not exists socialflow_recurrences (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        created_by_user_id uuid references socialflow_users(id) on delete set null,
        frequency text not null check (frequency in ('daily','weekly','monthly')),
        interval smallint not null default 1 check (interval between 1 and 52),
        weekdays smallint[] not null default '{}',
        day_of_month smallint check (day_of_month between 1 and 31),
        minute_of_day smallint not null check (minute_of_day between 0 and 1439),
        timezone text not null,
        start_date date not null,
        end_date date,
        max_occurrences integer check (max_occurrences > 0),
        occurrences_created integer not null default 0,
        next_run_at timestamptz,
        paused boolean not null default false,
        content text not null default '',
        first_comment text,
        platform_content jsonb not null default '{}'::jsonb,
        connected_account_ids uuid[] not null default '{}',
        media_ids uuid[] not null default '{}',
        tag_ids uuid[] not null default '{}',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists socialflow_recurrences_workspace_idx on socialflow_recurrences (workspace_id);
      create index if not exists socialflow_recurrences_due_idx on socialflow_recurrences (next_run_at) where paused = false;
      alter table socialflow_posts add column if not exists recurrence_id uuid references socialflow_recurrences(id) on delete set null;
      alter table socialflow_posts add column if not exists occurrence_index integer;
      -- One post per occurrence: the materializer can run twice without creating a duplicate.
      create unique index if not exists socialflow_posts_occurrence_idx on socialflow_posts (recurrence_id, occurrence_index) where recurrence_id is not null;
    `,
  },
  {
    name: "0005_first_comment",
    sql: `
      alter table socialflow_posts add column if not exists first_comment text;
      alter table socialflow_post_targets add column if not exists first_comment_status text;
      alter table socialflow_post_targets add column if not exists first_comment_error text;
      alter table socialflow_post_targets add column if not exists first_comment_external_id text;
    `,
  },
  {
    name: "0006_tags",
    sql: `
      create table if not exists socialflow_tags (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        name text not null,
        color text not null default '#6366f1',
        created_at timestamptz not null default now(),
        unique (workspace_id, name)
      );
      create table if not exists socialflow_post_tags (
        post_id uuid not null references socialflow_posts(id) on delete cascade,
        tag_id uuid not null references socialflow_tags(id) on delete cascade,
        primary key (post_id, tag_id)
      );
      create index if not exists socialflow_post_tags_tag_idx on socialflow_post_tags (tag_id);
    `,
  },
  {
    name: "0007_custom_fields",
    sql: `
      create table if not exists socialflow_custom_fields (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        key text not null,
        label text not null,
        type text not null check (type in ('text','number','date','select','url')),
        options jsonb not null default '[]'::jsonb,
        required boolean not null default false,
        position integer not null default 0,
        created_at timestamptz not null default now(),
        unique (workspace_id, key)
      );
      create table if not exists socialflow_post_custom_values (
        post_id uuid not null references socialflow_posts(id) on delete cascade,
        field_id uuid not null references socialflow_custom_fields(id) on delete cascade,
        value text not null,
        primary key (post_id, field_id)
      );
    `,
  },
  {
    name: "0008_mention_groups",
    sql: `
      create table if not exists socialflow_mention_groups (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        name text not null,
        handles text[] not null default '{}',
        created_at timestamptz not null default now(),
        unique (workspace_id, name)
      );
    `,
  },
  {
    name: "0009_team",
    sql: `
      alter table socialflow_sessions add column if not exists active_workspace_id uuid references socialflow_workspaces(id) on delete set null;
      -- The single legacy non-owner role becomes editor (same day-to-day access).
      update socialflow_workspace_members set role = 'editor' where role = 'member';
      create table if not exists socialflow_invitations (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        email text not null,
        role text not null,
        invited_by_user_id uuid references socialflow_users(id) on delete set null,
        token_hash text not null,
        expires_at timestamptz not null,
        accepted_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz not null default now()
      );
      create unique index if not exists socialflow_invitations_token_idx on socialflow_invitations (token_hash);
      create index if not exists socialflow_invitations_workspace_idx on socialflow_invitations (workspace_id);
      create table if not exists socialflow_audit_log (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        actor_user_id uuid references socialflow_users(id) on delete set null,
        action text not null,
        target text,
        detail jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists socialflow_audit_workspace_idx on socialflow_audit_log (workspace_id, created_at);
    `,
  },
  {
    name: "0010_analytics",
    sql: `
      create table if not exists socialflow_account_metrics (
        id uuid primary key default gen_random_uuid(),
        connected_account_id uuid not null references socialflow_connected_accounts(id) on delete cascade,
        captured_at timestamptz not null default now(),
        followers integer,
        media_count integer,
        views_total bigint
      );
      create index if not exists socialflow_account_metrics_idx on socialflow_account_metrics (connected_account_id, captured_at);
      create table if not exists socialflow_post_metrics (
        id uuid primary key default gen_random_uuid(),
        post_target_id uuid not null references socialflow_post_targets(id) on delete cascade,
        captured_at timestamptz not null default now(),
        likes integer,
        comments integer,
        shares integer,
        views bigint,
        impressions bigint,
        reach bigint,
        saves integer
      );
      create index if not exists socialflow_post_metrics_idx on socialflow_post_metrics (post_target_id, captured_at);
    `,
  },
  ...approvalsMigrations,
  ...inboxMigrations,
  ...aiMigrations,
  ...libraryMigrations,
  ...inboxDmMigrations,
  ...reportsMigrations,
  ...linkMigrations,
];

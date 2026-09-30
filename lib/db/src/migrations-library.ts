/* Content Library tables. Additive only. Register `libraryMigrations` in migrations.ts. */
export const libraryMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0014_content_library",
    sql: `
      create table if not exists socialflow_library_folders (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        name text not null,
        created_at timestamptz not null default now()
      );
      create unique index if not exists socialflow_library_folders_name_unique on socialflow_library_folders (workspace_id, lower(name));
      create table if not exists socialflow_library_items (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        kind text not null check (kind in ('media','caption','template','snippet')),
        title text not null,
        body text,
        media_id uuid references socialflow_media(id) on delete cascade,
        folder_id uuid references socialflow_library_folders(id) on delete set null,
        labels text[] not null default '{}',
        favorite boolean not null default false,
        use_count integer not null default 0,
        last_used_at timestamptz,
        created_by uuid references socialflow_users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists socialflow_library_items_ws_idx on socialflow_library_items (workspace_id, created_at);
      create index if not exists socialflow_library_items_media_idx on socialflow_library_items (media_id);
    `,
  },
];

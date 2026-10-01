/**
 * The WordPress plugin: a third kind of automation whose posts are pushed by the SocialFlow plugin on the site instead
 * of being polled for, and the connection (signing key and what the plugin reported about its site) that belongs to it.
 * Additive: the kind check is widened, nothing is removed or rewritten.
 */
export const wordpressPluginMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0020_wordpress_plugin",
    sql: `
      -- Widen the kind check. The old check is found by its definition, so its name doesn't matter.
      do $$
      declare existing record;
      begin
        for existing in
          select conname from pg_constraint
          where conrelid = 'socialflow_automations'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%kind%'
        loop
          execute format('alter table socialflow_automations drop constraint %I', existing.conname);
        end loop;
      end $$;
      alter table socialflow_automations
        add constraint socialflow_automations_kind_check check (kind in ('wordpress','rss','wordpress_plugin'));

      -- One row per plugin automation. The secret signs the plugin's requests; it is stored encrypted and never returned
      -- after it has been shown once. Replacing the key replaces key_id and the secret, which cuts the old plugin off.
      create table if not exists socialflow_wordpress_connections (
        id uuid primary key default gen_random_uuid(),
        automation_id uuid not null unique references socialflow_automations(id) on delete cascade,
        workspace_id uuid not null references socialflow_workspaces(id) on delete cascade,
        key_id text not null unique,
        secret_encrypted text not null,
        status text not null default 'pending' check (status in ('pending','connected','disconnected')),
        site_url text,
        site_name text,
        wp_version text,
        plugin_version text,
        connected_at timestamptz,
        last_seen_at timestamptz,
        last_post_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists socialflow_wordpress_connections_workspace_idx on socialflow_wordpress_connections (workspace_id);
    `,
  },
];

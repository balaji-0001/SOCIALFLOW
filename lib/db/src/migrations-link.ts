/*
 * A link attached to a post (the preview card the composer showed). Additive only: nullable columns on the posts
 * table. link_title / link_description / link_image_url are a snapshot of what the user saw and may have edited.
 */
export const linkMigrations: Array<{ name: string; sql: string }> = [
  {
    name: "0017_post_link",
    sql: `
      alter table socialflow_posts add column if not exists link_url text;
      alter table socialflow_posts add column if not exists link_title text;
      alter table socialflow_posts add column if not exists link_description text;
      alter table socialflow_posts add column if not exists link_image_url text;
    `,
  },
];

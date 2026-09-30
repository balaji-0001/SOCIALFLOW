// Brings the test database up to date before any test file runs (the API does the same at boot).
export default async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const { pool, runMigrations } = await import("@workspace/db");
  try {
    await runMigrations(pool);
  } catch (error) {
    console.warn("Test database migrations were not applied:", error instanceof Error ? error.message : error);
  } finally {
    await pool.end();
  }
}

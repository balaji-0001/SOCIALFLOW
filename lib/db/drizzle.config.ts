import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// For drizzle-kit's read-only tools (studio, check). The schema is changed only through migrations
// (src/migrations.ts): `drizzle-kit push` would drop the check constraints and foreign keys it does not know about.
export default defineConfig({
  schema: "./src/schema/index.ts",
  dialect: "mysql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});

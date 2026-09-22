import { defineConfig } from "vitest/config";

// Test-only values. Real credentials come from Replit Secrets and are never
// needed by the test suite: all provider HTTP calls are mocked.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test-session-secret",
      TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      FACEBOOK_APP_ID: "test-app-id",
      FACEBOOK_APP_SECRET: "test-app-secret",
      FACEBOOK_GRAPH_API_VERSION: "v26.0",
      OAUTH_REDIRECT_BASE_URL: "https://socialflow.test",
      LOG_LEVEL: "silent",
    },
  },
});

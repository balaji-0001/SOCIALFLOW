import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Test-only values. Real credentials come from Replit Secrets and are never
// needed by the test suite: all provider HTTP calls are mocked.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test-session-secret",
      TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      FACEBOOK_APP_ID: "test-app-id",
      FACEBOOK_APP_SECRET: "test-app-secret",
      FACEBOOK_GRAPH_API_VERSION: "v26.0",
      INSTAGRAM_APP_ID: "test-ig-app-id",
      INSTAGRAM_APP_SECRET: "test-ig-app-secret",
      LINKEDIN_CLIENT_ID: "test-linkedin-id",
      LINKEDIN_CLIENT_SECRET: "test-linkedin-secret",
      GOOGLE_CLIENT_ID: "test-google-id",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
      // High enough that no test file's own signup/login volume trips it.
      AUTH_LOGIN_RATE_LIMIT: "10000",
      AUTH_SIGNUP_RATE_LIMIT: "10000",
      OAUTH_REDIRECT_BASE_URL: "https://socialflow.test",
      // Uploads go to a throwaway directory, with small limits so tests can exceed them cheaply.
      MEDIA_STORAGE_DIR: mkdtempSync(join(tmpdir(), "socialflow-media-test-")),
      MEDIA_MAX_IMAGE_BYTES: "300000",
      MEDIA_MAX_VIDEO_BYTES: "1000000",
      MEDIA_MAX_FILES_PER_POST: "4",
      MEDIA_WORKSPACE_QUOTA_BYTES: "1500000",
      MEDIA_UPLOAD_RATE_LIMIT: "10000",
      LOG_LEVEL: "silent",
    },
  },
});

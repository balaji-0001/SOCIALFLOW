import { describe, expect, it } from "vitest";
import { getCallbackUrl, getRedirectBaseUrl } from "./config";

describe("redirect URL configuration", () => {
  it("prefers OAUTH_REDIRECT_BASE_URL and strips paths", () => {
    expect(getRedirectBaseUrl({ OAUTH_REDIRECT_BASE_URL: "https://app.example.com/some/path", REPLIT_DEV_DOMAIN: "dev.replit.dev" })).toBe(
      "https://app.example.com",
    );
  });

  it("uses REPLIT_DEV_DOMAIN in development and REPLIT_DOMAINS in production", () => {
    expect(getRedirectBaseUrl({ NODE_ENV: "development", REPLIT_DEV_DOMAIN: "abc.replit.dev" })).toBe("https://abc.replit.dev");
    expect(getRedirectBaseUrl({ NODE_ENV: "production", REPLIT_DEV_DOMAIN: "abc.replit.dev", REPLIT_DOMAINS: "app.replit.app,x.com" })).toBe(
      "https://app.replit.app",
    );
  });

  it("rejects non-HTTPS URLs except localhost", () => {
    expect(getRedirectBaseUrl({ OAUTH_REDIRECT_BASE_URL: "http://app.example.com" })).toBeNull();
    expect(getRedirectBaseUrl({ OAUTH_REDIRECT_BASE_URL: "http://localhost:8080" })).toBe("http://localhost:8080");
    expect(getRedirectBaseUrl({})).toBeNull();
  });

  it("builds per-platform callback URLs", () => {
    expect(getCallbackUrl("facebook", { OAUTH_REDIRECT_BASE_URL: "https://app.example.com" })).toBe(
      "https://app.example.com/api/connections/facebook/callback",
    );
  });
});

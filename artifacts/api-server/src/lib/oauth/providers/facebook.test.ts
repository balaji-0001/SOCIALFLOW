import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthError } from "../errors";
import { installFakeGraph } from "../../../test/fake-graph";
import { createFacebookAdapter } from "./facebook";

const credentials = { clientId: "test-app-id", clientSecret: "test-app-secret" };
const redirectUri = "https://socialflow.test/api/connections/facebook/callback";

describe("Facebook adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("builds the Facebook Login dialog URL", () => {
    const url = new URL(createFacebookAdapter(credentials).buildAuthorizationUrl({ state: "s1", redirectUri, reconnect: false }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("test-app-id");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(
      expect.arrayContaining(["pages_show_list", "pages_read_engagement", "pages_manage_posts"]),
    );
    expect(url.searchParams.has("auth_type")).toBe(false);
    expect(url.toString()).not.toContain("test-app-secret");
  });

  it("re-requests declined permissions on reconnect and supports Login for Business config_id", () => {
    vi.stubEnv("FACEBOOK_LOGIN_CONFIG_ID", "cfg-123");
    const url = new URL(createFacebookAdapter(credentials).buildAuthorizationUrl({ state: "s", redirectUri, reconnect: true }));
    expect(url.searchParams.get("auth_type")).toBe("rerequest");
    expect(url.searchParams.get("config_id")).toBe("cfg-123");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("exchanges the code, upgrades to a long-lived token and returns Pages as candidates", async () => {
    const { calls } = installFakeGraph();
    const result = await createFacebookAdapter(credentials).handleCallback({ code: "CODE", redirectUri });

    expect(result.externalUserId).toBe("fb-user-42");
    expect(result.candidates.map((c) => [c.externalAccountId, c.selectable])).toEqual([
      ["1001", true],
      ["1002", false],
    ]);
    expect(result.candidates[0]).toMatchObject({ accountType: "facebook_page", accessToken: "PAGE_TOKEN_1001", tokenExpiresAt: null });
    expect(result.candidates[1]!.warnings[0]).toMatch(/role/);

    const exchange = calls.find((u) => u.searchParams.get("code") === "CODE")!;
    expect(exchange.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(calls.some((u) => u.searchParams.get("grant_type") === "fb_exchange_token")).toBe(true);

    // Every call made with a user token carries a valid appsecret_proof.
    const accounts = calls.find((u) => u.pathname.endsWith("/me/accounts"))!;
    expect(accounts.searchParams.get("access_token")).toBe("LONG_LIVED_USER_TOKEN");
    expect(accounts.searchParams.get("appsecret_proof")).toBe(
      createHmac("sha256", "test-app-secret").update("LONG_LIVED_USER_TOKEN").digest("hex"),
    );
  });

  it("fails with missing_scopes when a required permission was declined", async () => {
    installFakeGraph({ granted: ["pages_show_list", "pages_read_engagement"], declined: ["pages_manage_posts"] });
    const error = await createFacebookAdapter(credentials).handleCallback({ code: "C", redirectUri }).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.code).toBe("missing_scopes");
    expect(error.details.missingScopes).toEqual(["pages_manage_posts"]);
  });

  it("fails with no_accounts when no Pages were shared", async () => {
    installFakeGraph({ pages: [] });
    await expect(createFacebookAdapter(credentials).handleCallback({ code: "C", redirectUri })).rejects.toMatchObject({ code: "no_accounts" });
  });

  it("maps a rejected authorization code to token_exchange_failed", async () => {
    installFakeGraph({ tokenExchangeError: { code: 100, message: "Invalid verification code format." } });
    await expect(createFacebookAdapter(credentials).handleCallback({ code: "bad", redirectUri })).rejects.toMatchObject({
      code: "token_exchange_failed",
    });
  });

  describe("verifyAccount", () => {
    const account = { externalAccountId: "1001", accessToken: "PAGE_TOKEN_1001", refreshToken: null, tokenExpiresAt: null };

    it("reports active with refreshed profile data", async () => {
      installFakeGraph();
      const result = await createFacebookAdapter(credentials).verifyAccount(account);
      expect(result).toMatchObject({ status: "active", displayName: "Acme Bakery", tokenExpiresAt: null });
    });

    it("reports revoked when the user removed the app or changed password", async () => {
      installFakeGraph({ debugToken: { is_valid: false, error: { code: 190, subcode: 460, message: "Password changed" } } });
      expect(await createFacebookAdapter(credentials).verifyAccount(account)).toMatchObject({ status: "revoked" });
    });

    it("reports expired for expired tokens", async () => {
      installFakeGraph({ debugToken: { is_valid: false, error: { code: 190, subcode: 463, message: "Expired" } } });
      expect(await createFacebookAdapter(credentials).verifyAccount(account)).toMatchObject({ status: "expired" });
    });

    it("reports missing_permissions when a scope was later removed", async () => {
      installFakeGraph({ debugToken: { is_valid: true, expires_at: 0, scopes: ["pages_show_list"] } });
      const result = await createFacebookAdapter(credentials).verifyAccount(account);
      expect(result.status).toBe("missing_permissions");
      expect(result.detail).toContain("pages_manage_posts");
    });

    it("reports missing_permissions when the Page role was removed", async () => {
      installFakeGraph({ pageError: { code: 200, message: "Permissions error" } });
      expect(await createFacebookAdapter(credentials).verifyAccount(account)).toMatchObject({ status: "missing_permissions" });
    });
  });
});

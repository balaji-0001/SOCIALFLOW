import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthError } from "../errors";
import { installFakeInstagram } from "../../../test/fake-instagram";
import { createInstagramAdapter } from "./instagram";

const credentials = { clientId: "test-ig-app-id", clientSecret: "test-ig-app-secret" };
const redirectUri = "https://socialflow.test/api/connections/instagram/callback";

describe("Instagram adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the Instagram Login authorization URL", () => {
    const url = new URL(createInstagramAdapter(credentials).buildAuthorizationUrl({ state: "s1", redirectUri, reconnect: false }));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-ig-app-id");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(
      expect.arrayContaining(["instagram_business_basic", "instagram_business_content_publish"]),
    );
    expect(url.toString()).not.toContain("test-ig-app-secret");
  });

  it("exchanges the code, upgrades to a long-lived token and returns the professional account as a candidate", async () => {
    const { calls } = installFakeInstagram();
    const result = await createInstagramAdapter(credentials).handleCallback({ code: "CODE", redirectUri });

    expect(result.externalUserId).toBe("28524542100518920");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      externalAccountId: "28524542100518920",
      accountType: "instagram_business",
      displayName: "Acme Bakery",
      username: "acme.bakery",
      accessToken: "IG_LONG_LIVED",
      refreshToken: "IG_LONG_LIVED",
      selectable: true,
    });
    expect(result.candidates[0]!.tokenExpiresAt).toBeInstanceOf(Date);

    const shortLived = calls.find((u) => u.hostname === "api.instagram.com")!;
    expect(shortLived.pathname).toBe("/oauth/access_token");
    const longLived = calls.find((u) => u.hostname === "graph.instagram.com" && u.pathname === "/access_token")!;
    expect(longLived.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(longLived.searchParams.get("access_token")).toBe("IG_SHORT_LIVED");
  });

  it("preserves the exact user_id even though Instagram sends it as a bare JSON number past Number.MAX_SAFE_INTEGER", async () => {
    // Regression test for a real production failure: Instagram's user_id
    // (17 digits) is sent as an unquoted JSON number. Number.MAX_SAFE_INTEGER
    // is only 16 digits, so naively `JSON.parse`-ing this value and calling
    // `String()` on it would silently round to the wrong ID. This exact ID
    // was captured from a real, otherwise-successful Instagram response that
    // an earlier version of this adapter rejected entirely because it only
    // accepted `user_id` as a JSON string.
    const realWorldId = "28524542100518920";
    installFakeInstagram({ profile: { user_id: realWorldId } });
    const result = await createInstagramAdapter(credentials).handleCallback({ code: "CODE", redirectUri });
    expect(result.externalUserId).toBe(realWorldId);
    expect(result.candidates[0]!.externalAccountId).toBe(realWorldId);
    // Sanity-check this ID actually exceeds what a plain JS number preserves,
    // so this test would fail loudly if the precision-preserving parsing
    // were ever removed.
    expect(Number.isSafeInteger(Number(realWorldId))).toBe(false);
  });

  it("maps a creator account to accountType instagram_creator", async () => {
    installFakeInstagram({ profile: { account_type: "CREATOR" } });
    const result = await createInstagramAdapter(credentials).handleCallback({ code: "C", redirectUri });
    expect(result.candidates[0]!.accountType).toBe("instagram_creator");
  });

  it("fails with missing_scopes when a required permission was declined", async () => {
    installFakeInstagram({ permissions: ["instagram_business_basic"] });
    const error = await createInstagramAdapter(credentials).handleCallback({ code: "C", redirectUri }).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.code).toBe("missing_scopes");
    expect(error.details.missingScopes).toEqual(["instagram_business_content_publish"]);
  });

  it("rejects personal accounts with a clear error", async () => {
    installFakeInstagram({ profile: { account_type: "PERSONAL" } });
    await expect(createInstagramAdapter(credentials).handleCallback({ code: "C", redirectUri })).rejects.toMatchObject({
      code: "no_accounts",
    });
  });

  it("maps a rejected authorization code to token_exchange_failed and captures Instagram's error message", async () => {
    // Regression test: api.instagram.com/oauth/access_token returns a FLAT
    // error body ({error_type, code, error_message}), not the nested
    // {error: {...}} shape graph.instagram.com uses. An earlier version of
    // this adapter only recognized the nested shape, so a real rejected
    // code produced a token_exchange_failed error with no diagnostic
    // message at all, making it undebuggable from the server logs.
    installFakeInstagram({ shortLivedError: { error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" } });
    const error = await createInstagramAdapter(credentials).handleCallback({ code: "bad", redirectUri }).catch((e) => e);
    expect(error).toMatchObject({ code: "token_exchange_failed" });
    expect(error.details.providerMessage).toBe("Invalid authorization code");
  });

  describe("refreshAccessToken", () => {
    it("returns a refreshed long-lived token", async () => {
      installFakeInstagram();
      const result = await createInstagramAdapter(credentials).refreshAccessToken!("IG_LONG_LIVED");
      expect(result.accessToken).toBe("IG_REFRESHED");
      expect(result.refreshToken).toBe("IG_REFRESHED");
      expect(result.tokenExpiresAt).toBeInstanceOf(Date);
    });

    it("maps a failed refresh to provider errors", async () => {
      installFakeInstagram({ refreshError: { code: 190, message: "Token no longer valid" } });
      await expect(createInstagramAdapter(credentials).refreshAccessToken!("STALE")).rejects.toBeInstanceOf(OAuthError);
    });
  });

  describe("verifyAccount", () => {
    const account = { externalAccountId: "28524542100518920", accessToken: "IG_LONG_LIVED", refreshToken: null, tokenExpiresAt: null };

    it("reports active with refreshed profile data", async () => {
      installFakeInstagram();
      const result = await createInstagramAdapter(credentials).verifyAccount(account);
      expect(result).toMatchObject({ status: "active", displayName: "Acme Bakery" });
    });

    it("reports revoked when the token is no longer valid", async () => {
      installFakeInstagram({ meError: { code: 190, error_subcode: 460, message: "Token revoked" } });
      expect(await createInstagramAdapter(credentials).verifyAccount(account)).toMatchObject({ status: "revoked" });
    });

    it("reports expired for expired tokens", async () => {
      installFakeInstagram({ meError: { code: 190, error_subcode: 463, message: "Expired" } });
      expect(await createInstagramAdapter(credentials).verifyAccount(account)).toMatchObject({ status: "expired" });
    });
  });
});

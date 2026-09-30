import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthError } from "../errors";
import { installFakeYouTube } from "../../../test/fake-youtube";
import { createYouTubeAdapter } from "./youtube";

const credentials = { clientId: "test-google-id", clientSecret: "test-google-secret" };
const redirectUri = "https://socialflow.test/api/connections/youtube/callback";

describe("YouTube adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the Google authorization URL with PKCE and offline access", () => {
    const url = new URL(
      createYouTubeAdapter(credentials).buildAuthorizationUrl({ state: "s1", redirectUri, reconnect: false, codeChallenge: "CHALLENGE" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-google-id");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"]),
    );
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  it("forces the consent screen on reconnect so a refresh token is re-issued", () => {
    const url = new URL(createYouTubeAdapter(credentials).buildAuthorizationUrl({ state: "s1", redirectUri, reconnect: true }));
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("exchanges the code with the PKCE verifier and returns channels as candidates", async () => {
    const { calls } = installFakeYouTube();
    const result = await createYouTubeAdapter(credentials).handleCallback({ code: "CODE", redirectUri, codeVerifier: "VERIFIER" });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      externalAccountId: "UC_test_channel_1",
      accountType: "youtube_channel",
      displayName: "Acme Studio",
      accessToken: "GOOG_ACCESS_TOKEN",
      refreshToken: "GOOG_REFRESH_TOKEN",
    });

    const tokenCall = calls.find((c) => c.url.pathname === "/token")!;
    expect(tokenCall.body?.get("code_verifier")).toBe("VERIFIER");
    expect(tokenCall.body?.get("grant_type")).toBe("authorization_code");
  });

  it("returns multiple candidates for Brand Account channels", async () => {
    installFakeYouTube({ channels: [{ id: "UC_a", title: "Channel A" }, { id: "UC_b", title: "Channel B" }] });
    const result = await createYouTubeAdapter(credentials).handleCallback({ code: "C", redirectUri });
    expect(result.candidates.map((c) => c.displayName)).toEqual(["Channel A", "Channel B"]);
  });

  it("fails with no_accounts when the Google account has no YouTube channel", async () => {
    installFakeYouTube({ channels: [] });
    await expect(createYouTubeAdapter(credentials).handleCallback({ code: "C", redirectUri })).rejects.toMatchObject({ code: "no_accounts" });
  });

  it("fails with missing_scopes when youtube.upload was declined", async () => {
    installFakeYouTube({ scope: ["https://www.googleapis.com/auth/youtube.readonly"] });
    const error = await createYouTubeAdapter(credentials).handleCallback({ code: "C", redirectUri }).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.code).toBe("missing_scopes");
  });

  it("maps a rejected authorization code to token_exchange_failed", async () => {
    installFakeYouTube({ tokenError: { error: "invalid_grant", error_description: "Malformed auth code" } });
    await expect(createYouTubeAdapter(credentials).handleCallback({ code: "bad", redirectUri })).rejects.toMatchObject({
      code: "token_exchange_failed",
    });
  });

  describe("refreshAccessToken", () => {
    it("returns a new access token and keeps the same refresh token", async () => {
      installFakeYouTube();
      const result = await createYouTubeAdapter(credentials).refreshAccessToken!("GOOG_REFRESH_TOKEN");
      expect(result.accessToken).toBe("GOOG_ACCESS_TOKEN");
      expect(result.refreshToken).toBe("GOOG_REFRESH_TOKEN");
    });

    it("maps a revoked/expired refresh token to token_revoked", async () => {
      installFakeYouTube({ tokenError: { error: "invalid_grant", error_description: "Token has been expired or revoked" } });
      await expect(createYouTubeAdapter(credentials).refreshAccessToken!("STALE")).rejects.toMatchObject({ code: "token_revoked" });
    });
  });

  describe("verifyAccount", () => {
    const account = { externalAccountId: "UC_test_channel_1", accessToken: "GOOG_ACCESS_TOKEN", refreshToken: null, tokenExpiresAt: null };

    it("reports active with refreshed channel data", async () => {
      installFakeYouTube();
      const result = await createYouTubeAdapter(credentials).verifyAccount(account);
      expect(result).toMatchObject({ status: "active", displayName: "Acme Studio" });
    });

    it("reports revoked when the token is no longer valid", async () => {
      installFakeYouTube({ tokeninfoError: 400 });
      expect(await createYouTubeAdapter(credentials).verifyAccount(account)).toMatchObject({ status: "revoked" });
    });

    it("reports missing_permissions when a required scope was later removed", async () => {
      installFakeYouTube({ tokeninfoScope: ["https://www.googleapis.com/auth/youtube.readonly"] });
      const result = await createYouTubeAdapter(credentials).verifyAccount(account);
      expect(result.status).toBe("missing_permissions");
    });
  });
});

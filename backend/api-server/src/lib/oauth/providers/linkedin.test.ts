import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthError } from "../errors";
import { installFakeLinkedIn } from "../../../test/fake-linkedin";
import { createLinkedInAdapter } from "./linkedin";

const credentials = { clientId: "test-linkedin-id", clientSecret: "test-linkedin-secret" };
const redirectUri = "https://socialflow.test/api/connections/linkedin/callback";

describe("LinkedIn adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("builds the LinkedIn authorization URL with member scopes only by default", () => {
    const url = new URL(createLinkedInAdapter(credentials).buildAuthorizationUrl({ state: "s1", redirectUri, reconnect: false }));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("client_id")).toBe("test-linkedin-id");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(url.toString()).not.toContain("test-linkedin-secret");
  });

  it("adds organization scopes when LINKEDIN_ORG_ENABLED is set", () => {
    vi.stubEnv("LINKEDIN_ORG_ENABLED", "true");
    const url = new URL(createLinkedInAdapter(credentials).buildAuthorizationUrl({ state: "s1", redirectUri, reconnect: false }));
    expect(url.searchParams.get("scope")).toContain("rw_organization_admin");
  });

  it("exchanges the code and returns the member profile as a candidate", async () => {
    const { calls } = installFakeLinkedIn();
    const result = await createLinkedInAdapter(credentials).handleCallback({ code: "CODE", redirectUri });

    expect(result.externalUserId).toBe("li-member-123");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      externalAccountId: "li-member-123",
      accountType: "linkedin_member",
      displayName: "Jordan Lee",
      accessToken: "LI_ACCESS_TOKEN",
      refreshToken: "LI_REFRESH_TOKEN",
    });

    const tokenCall = calls.find((c) => c.url.pathname === "/oauth/v2/accessToken")!;
    expect(tokenCall.body?.get("grant_type")).toBe("authorization_code");
    expect(tokenCall.body?.get("code")).toBe("CODE");
  });

  it("does not request organization discovery when LINKEDIN_ORG_ENABLED is unset, even with org scopes granted", async () => {
    installFakeLinkedIn({ scope: ["openid", "profile", "w_member_social", "rw_organization_admin"], administeredOrgs: [{ id: "555", name: "Acme Inc" }] });
    const result = await createLinkedInAdapter(credentials).handleCallback({ code: "C", redirectUri });
    expect(result.candidates).toHaveLength(1);
  });

  it("discovers administered organizations when org discovery is enabled and configured", async () => {
    vi.stubEnv("LINKEDIN_ORG_ENABLED", "true");
    vi.stubEnv("LINKEDIN_API_VERSION", "202601");
    installFakeLinkedIn({
      scope: ["openid", "profile", "w_member_social", "rw_organization_admin"],
      administeredOrgs: [{ id: "555", name: "Acme Inc" }],
    });
    const result = await createLinkedInAdapter(credentials).handleCallback({ code: "C", redirectUri });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[1]).toMatchObject({ externalAccountId: "555", accountType: "linkedin_organization", displayName: "Acme Inc" });
  });

  it("falls back to member-only when the app lacks Community Management API access", async () => {
    vi.stubEnv("LINKEDIN_ORG_ENABLED", "true");
    vi.stubEnv("LINKEDIN_API_VERSION", "202601");
    installFakeLinkedIn({ scope: ["openid", "profile", "w_member_social", "rw_organization_admin"], orgAclsStatus: 403 });
    const result = await createLinkedInAdapter(credentials).handleCallback({ code: "C", redirectUri });
    expect(result.candidates).toHaveLength(1);
  });

  it("fails with missing_scopes when w_member_social was declined", async () => {
    installFakeLinkedIn({ scope: ["openid", "profile"] });
    const error = await createLinkedInAdapter(credentials).handleCallback({ code: "C", redirectUri }).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.code).toBe("missing_scopes");
    expect(error.details.missingScopes).toEqual(["w_member_social"]);
  });

  it("maps a rejected authorization code to token_exchange_failed", async () => {
    installFakeLinkedIn({ tokenError: { error: "invalid_grant", error_description: "The authorization code is invalid or expired" } });
    await expect(createLinkedInAdapter(credentials).handleCallback({ code: "bad", redirectUri })).rejects.toMatchObject({
      code: "token_exchange_failed",
    });
  });

  describe("refreshAccessToken", () => {
    it("returns a new access token and preserves the refresh token", async () => {
      installFakeLinkedIn();
      const result = await createLinkedInAdapter(credentials).refreshAccessToken!("LI_REFRESH_TOKEN");
      expect(result.accessToken).toBe("LI_ACCESS_TOKEN");
      expect(result.refreshToken).toBe("LI_REFRESH_TOKEN");
    });
  });

  describe("verifyAccount", () => {
    it("reports active for a member account with refreshed profile data", async () => {
      installFakeLinkedIn();
      const result = await createLinkedInAdapter(credentials).verifyAccount({
        externalAccountId: "li-member-123",
        accessToken: "LI_ACCESS_TOKEN",
        refreshToken: null,
        tokenExpiresAt: null,
        accountType: "linkedin_member",
      });
      expect(result).toMatchObject({ status: "active", displayName: "Jordan Lee" });
    });

    it("reports revoked for a member account when the token is invalid", async () => {
      installFakeLinkedIn({ userinfoStatus: 401 });
      const result = await createLinkedInAdapter(credentials).verifyAccount({
        externalAccountId: "li-member-123",
        accessToken: "BAD",
        refreshToken: null,
        tokenExpiresAt: null,
        accountType: "linkedin_member",
      });
      expect(result.status).toBe("revoked");
    });

    it("reports active for an organization account still administered, and missing_permissions once admin access is gone", async () => {
      vi.stubEnv("LINKEDIN_API_VERSION", "202601");
      installFakeLinkedIn({ administeredOrgs: [{ id: "555", name: "Acme Inc" }] });
      const adapter = createLinkedInAdapter(credentials);
      const account = { externalAccountId: "555", accessToken: "LI_ACCESS_TOKEN", refreshToken: null, tokenExpiresAt: null, accountType: "linkedin_organization" };

      const active = await adapter.verifyAccount(account);
      expect(active).toMatchObject({ status: "active", displayName: "Acme Inc" });

      installFakeLinkedIn({ administeredOrgs: [] });
      const revokedRole = await adapter.verifyAccount(account);
      expect(revokedRole.status).toBe("missing_permissions");
    });

    it("reports error for an organization account when LINKEDIN_API_VERSION isn't configured", async () => {
      installFakeLinkedIn();
      const result = await createLinkedInAdapter(credentials).verifyAccount({
        externalAccountId: "555",
        accessToken: "LI_ACCESS_TOKEN",
        refreshToken: null,
        tokenExpiresAt: null,
        accountType: "linkedin_organization",
      });
      expect(result.status).toBe("error");
    });
  });

  describe("publishPost", () => {
    const member = { externalAccountId: "li-member-123", accessToken: "LI_TOKEN", refreshToken: null, tokenExpiresAt: null, accountType: "linkedin_member" };

    it("publishes a public text post as the member", async () => {
      const { ugcPosts } = installFakeLinkedIn();
      const result = await createLinkedInAdapter(credentials).publishPost!(member, { text: "Shipping day" });

      expect(result.externalPostId).toBe("urn:li:share:7000000000000000001");
      expect(ugcPosts).toHaveLength(1);
      expect(ugcPosts[0]!.headers.get("authorization")).toBe("Bearer LI_TOKEN");
      expect(ugcPosts[0]!.headers.get("x-restli-protocol-version")).toBe("2.0.0");
      expect(ugcPosts[0]!.body).toMatchObject({
        author: "urn:li:person:li-member-123",
        lifecycleState: "PUBLISHED",
        specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: "Shipping day" }, shareMediaCategory: "NONE" } },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      });
    });

    it("publishes as the organization for an organization account", async () => {
      const { ugcPosts } = installFakeLinkedIn();
      await createLinkedInAdapter(credentials).publishPost!({ ...member, externalAccountId: "555", accountType: "linkedin_organization" }, { text: "From the company" });
      expect(ugcPosts[0]!.body.author).toBe("urn:li:organization:555");
    });

    it("tells an expired token (serviceErrorCode 65601) apart from a revoked one", async () => {
      const adapter = createLinkedInAdapter(credentials);
      installFakeLinkedIn({ publishError: { message: "The token used in the request has expired", status: 401, serviceErrorCode: 65601 } as never, publishStatus: 401 });
      await expect(adapter.publishPost!(member, { text: "x" })).rejects.toMatchObject({ code: "token_expired" });
    });

    it("maps an expired or revoked token, a missing permission and a rejected post", async () => {
      const adapter = createLinkedInAdapter(credentials);
      installFakeLinkedIn({ publishError: { message: "Invalid access token", status: 401 }, publishStatus: 401 });
      await expect(adapter.publishPost!(member, { text: "x" })).rejects.toMatchObject({ code: "token_revoked" });
      vi.unstubAllGlobals();
      installFakeLinkedIn({ publishError: { message: "Not enough permissions", status: 403 }, publishStatus: 403 });
      await expect(adapter.publishPost!(member, { text: "x" })).rejects.toMatchObject({ code: "insufficient_permissions" });
      vi.unstubAllGlobals();
      installFakeLinkedIn({ publishError: { message: "Content is a duplicate", status: 422 }, publishStatus: 422 });
      const error = await adapter.publishPost!(member, { text: "x" }).catch((e) => e);
      expect(error).toBeInstanceOf(OAuthError);
      expect(error.code).toBe("publish_failed");
      expect(error.details.providerMessage).toBe("Content is a duplicate");
    });
  });
});

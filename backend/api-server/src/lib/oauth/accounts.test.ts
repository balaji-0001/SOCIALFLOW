import { describe, expect, it } from "vitest";
import type { ConnectedAccount } from "@workspace/db";
import { OAuthError } from "./errors";
import { ensureFreshToken } from "./accounts";
import type { OAuthProviderAdapter } from "./types";

// A refresh attempt that fails for a transient reason must leave the account alone. Marking it
// expired would demand a reconnect the user doesn't need and make scheduled posts skip the account.
const soon = new Date(Date.now() + 60_000);
const account = {
  id: "acct-1",
  workspaceId: "ws-1",
  platform: "linkedin",
  externalAccountId: "ext-1",
  status: "active",
  statusDetail: null,
  tokenExpiresAt: soon,
  refreshTokenEncrypted: "not-decrypted-because-refresh-is-mocked-below",
} as unknown as ConnectedAccount;

function adapterFailingWith(error: unknown): OAuthProviderAdapter {
  return { refreshAccessToken: async () => { throw error; } } as unknown as OAuthProviderAdapter;
}

describe("ensureFreshToken", () => {
  it("returns the account unchanged when there is no refresh token", async () => {
    const noRefresh = { ...account, refreshTokenEncrypted: null } as ConnectedAccount;
    expect(await ensureFreshToken(noRefresh, adapterFailingWith(new Error("never called")))).toBe(noRefresh);
  });

  it("returns the account unchanged when the token isn't near expiry", async () => {
    const fresh = { ...account, tokenExpiresAt: new Date(Date.now() + 3600_000) } as ConnectedAccount;
    expect(await ensureFreshToken(fresh, adapterFailingWith(new Error("never called")))).toBe(fresh);
  });
});

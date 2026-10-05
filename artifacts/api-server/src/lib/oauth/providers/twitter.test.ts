import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthError } from "../errors";
import { installFakeTwitter } from "../../../test/fake-twitter";
import type { PublishMedia } from "../types";
import { createTwitterAdapter } from "./twitter";

// The X (Twitter) adapter against faked endpoints. No real network is contacted.

const credentials = { clientId: "test-twitter-id", clientSecret: "test-twitter-secret" };
const redirectUri = "https://socialflow.test/api/connections/twitter/callback";
const adapter = () => createTwitterAdapter(credentials);
const account = { externalAccountId: "2244994945", accessToken: "X_ACCESS_1", refreshToken: "X_REFRESH_1", tokenExpiresAt: null, accountType: "twitter_account" };

const dir = mkdtempSync(join(tmpdir(), "socialflow-x-"));
function file(name: string, mimeType: string, bytes: number): PublishMedia {
  const filePath = join(dir, name);
  writeFileSync(filePath, Buffer.alloc(bytes, 7));
  return { kind: mimeType.startsWith("video/") ? "video" : "image", mimeType, fileName: name, sizeBytes: bytes, filePath, publicUrl: null };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("X adapter: connecting", () => {
  it("builds the authorization URL with PKCE and the permissions posting needs", () => {
    const url = new URL(adapter().buildAuthorizationUrl({ state: "s1", redirectUri, reconnect: false, codeChallenge: "CHALLENGE" }));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-twitter-id");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["media.write", "offline.access", "tweet.read", "tweet.write", "users.read"]);
    // The client secret never goes into a URL the browser sees.
    expect(url.toString()).not.toContain("test-twitter-secret");
  });

  it("refuses to build a sign-in address without a PKCE challenge", () => {
    expect(() => adapter().buildAuthorizationUrl({ state: "s1", redirectUri, reconnect: false })).toThrow(OAuthError);
  });

  it("exchanges the code as a confidential client and returns the profile as the one account", async () => {
    const { tokenCalls } = installFakeTwitter();
    const result = await adapter().handleCallback({ code: "CODE", redirectUri, codeVerifier: "VERIFIER" });

    expect(result.externalUserId).toBe("2244994945");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      externalAccountId: "2244994945", accountType: "twitter_account", displayName: "Acme Studio", username: "acmestudio",
      avatarUrl: "https://example.test/x-avatar.png", accessToken: "X_ACCESS_1", refreshToken: "X_REFRESH_1", selectable: true,
    });
    expect(result.candidates[0]!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7000 * 1000);

    const call = tokenCalls[0]!;
    expect(call.body.get("grant_type")).toBe("authorization_code");
    expect(call.body.get("code")).toBe("CODE");
    expect(call.body.get("code_verifier")).toBe("VERIFIER");
    expect(call.body.get("redirect_uri")).toBe(redirectUri);
    expect(call.authorization).toBe(`Basic ${Buffer.from("test-twitter-id:test-twitter-secret").toString("base64")}`);
    expect(call.body.has("client_secret")).toBe(false);
  });

  it("fails with missing_scopes when the app is read-only", async () => {
    installFakeTwitter({ scope: ["tweet.read", "users.read", "offline.access"] });
    const error = await adapter().handleCallback({ code: "C", redirectUri, codeVerifier: "V" }).catch((e) => e);
    expect(error).toMatchObject({ code: "missing_scopes" });
    expect(error.details.missingScopes).toEqual(["tweet.write", "media.write"]);
    expect(error.message).toContain("Read and write");
  });

  it("maps a rejected authorization code to token_exchange_failed", async () => {
    installFakeTwitter({ tokenError: { body: { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." } } });
    await expect(adapter().handleCallback({ code: "bad", redirectUri, codeVerifier: "V" })).rejects.toMatchObject({ code: "token_exchange_failed" });
  });

  it("maps wrong app credentials to token_exchange_failed, not to a broken account", async () => {
    installFakeTwitter({ tokenError: { status: 401, body: { error: "unauthorized_client", error_description: "Missing valid authorization header" } } });
    await expect(adapter().handleCallback({ code: "C", redirectUri, codeVerifier: "V" })).rejects.toMatchObject({ code: "token_exchange_failed" });
  });
});

describe("X adapter: tokens", () => {
  it("stores the new refresh token every refresh returns", async () => {
    installFakeTwitter();
    const first = await adapter().handleCallback({ code: "C", redirectUri, codeVerifier: "V" });
    const refreshed = await adapter().refreshAccessToken!(first.candidates[0]!.refreshToken!);
    expect(refreshed).toMatchObject({ accessToken: "X_ACCESS_2", refreshToken: "X_REFRESH_2" });
    expect(refreshed.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("reports a used or revoked refresh token as token_revoked", async () => {
    installFakeTwitter();
    const first = await adapter().handleCallback({ code: "C", redirectUri, codeVerifier: "V" });
    await adapter().refreshAccessToken!(first.candidates[0]!.refreshToken!);
    // The first refresh retired X_REFRESH_1.
    await expect(adapter().refreshAccessToken!("X_REFRESH_1")).rejects.toMatchObject({ code: "token_revoked" });
  });

  it("leaves the account alone when X is rate limiting the refresh", async () => {
    installFakeTwitter({ tokenError: { status: 429, body: { title: "Too Many Requests", detail: "Too Many Requests", status: 429 } } });
    await expect(adapter().refreshAccessToken!("X_REFRESH_1")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("verifies an account and reports revoked or missing permission honestly", async () => {
    installFakeTwitter();
    expect(await adapter().verifyAccount(account)).toMatchObject({ status: "active", displayName: "Acme Studio", avatarUrl: "https://example.test/x-avatar.png" });
    installFakeTwitter({ meStatus: 401 });
    expect(await adapter().verifyAccount(account)).toMatchObject({ status: "revoked" });
    installFakeTwitter({ meStatus: 403 });
    expect(await adapter().verifyAccount(account)).toMatchObject({ status: "missing_permissions" });
  });
});

describe("X adapter: publishing", () => {
  it("posts text and returns the post's ID", async () => {
    const { posts } = installFakeTwitter();
    const result = await adapter().publishPost!(account, { text: "  Hello from SocialFlow  " });
    expect(result).toEqual({ externalPostId: posts[0]!.id });
    expect(posts[0]!.body).toEqual({ text: "Hello from SocialFlow" });
    expect(posts[0]!.authorization).toBe("Bearer X_ACCESS_1");
  });

  it("keeps a link that is already in the text, and adds one that was attached but not written", async () => {
    const { posts } = installFakeTwitter();
    const link = { url: "https://example.com/story", title: "The story", description: null, imageUrl: null };
    await adapter().publishPost!(account, { text: "Read https://example.com/story today", link });
    await adapter().publishPost!(account, { text: "Worth a read", link });
    expect(posts[0]!.body.text).toBe("Read https://example.com/story today");
    expect(posts[1]!.body.text).toBe("Worth a read\n\nhttps://example.com/story");
  });

  it("refuses a post over 280 as X counts it, before anything is sent", async () => {
    const { posts, fetchMock } = installFakeTwitter();
    const error = await adapter().publishPost!(account, { text: "字".repeat(141) }).catch((e) => e);
    expect(error).toMatchObject({ code: "publish_failed" });
    expect(error.details.providerMessage).toContain("282");
    expect(posts).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // A long link still fits, because a link counts as 23.
    await adapter().publishPost!(account, { text: `${"a".repeat(250)} https://example.com/${"x".repeat(200)}` });
    expect(posts).toHaveLength(1);
  });

  it("uploads photos in pieces and attaches them in order", async () => {
    const { posts, uploads } = installFakeTwitter();
    const small = file("a.jpg", "image/jpeg", 1200);
    const large = file("b.png", "image/png", 4 * 1024 * 1024 + 500);
    await adapter().publishPost!(account, { text: "Two photos", media: [small, large] });

    expect(uploads.map((upload) => upload.init)).toEqual([
      { media_type: "image/jpeg", total_bytes: 1200, media_category: "tweet_image" },
      { media_type: "image/png", total_bytes: 4 * 1024 * 1024 + 500, media_category: "tweet_image" },
    ]);
    expect(uploads[0]!.segments).toEqual([{ index: 0, bytes: 1200 }]);
    expect(uploads[1]!.segments).toEqual([{ index: 0, bytes: 4 * 1024 * 1024 }, { index: 1, bytes: 500 }]);
    expect(uploads.every((upload) => upload.finalized)).toBe(true);
    expect(posts[0]!.body).toEqual({ text: "Two photos", media: { media_ids: [uploads[0]!.id, uploads[1]!.id] } });
  });

  it("waits for a video to be processed, and uses the GIF and video categories", async () => {
    const { posts, uploads } = installFakeTwitter({ processing: ["in_progress", "succeeded"] });
    await adapter().publishPost!(account, { text: "A clip", media: [file("clip.mp4", "video/mp4", 3000)] });
    await adapter().publishPost!(account, { text: "A GIF", media: [file("loop.gif", "image/gif", 900)] });
    expect(uploads.map((upload) => upload.init.media_category)).toEqual(["tweet_video", "tweet_gif"]);
    expect(posts.map((post) => (post.body.media as { media_ids: string[] }).media_ids)).toEqual([[uploads[0]!.id], [uploads[1]!.id]]);
  }, 20_000);

  it("fails the post, without posting, when X can't process a video", async () => {
    const { posts } = installFakeTwitter({ processing: ["failed"] });
    const error = await adapter().publishPost!(account, { text: "A clip", media: [file("bad.mp4", "video/mp4", 3000)] }).catch((e) => e);
    expect(error).toMatchObject({ code: "publish_failed" });
    expect(error.details.providerMessage).toContain("bad.mp4");
    expect(posts).toHaveLength(0);
  }, 20_000);

  it("reports a refused post (a duplicate) as a failed post, never as a broken account", async () => {
    installFakeTwitter({ postError: { status: 403, body: { title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content.", type: "about:blank", status: 403 } } });
    const error = await adapter().publishPost!(account, { text: "Same again" }).catch((e) => e);
    expect(error).toMatchObject({ code: "publish_failed" });
    expect(error.details.providerMessage).toBe("You are not allowed to create a Tweet with duplicate content.");
  });

  it("maps an invalid token, a rate limit and an empty credit balance", async () => {
    installFakeTwitter({ postError: { status: 401, body: { title: "Unauthorized", detail: "Unauthorized", status: 401 } } });
    await expect(adapter().publishPost!(account, { text: "x" })).rejects.toMatchObject({ code: "token_revoked" });
    installFakeTwitter({ postError: { status: 429, body: { title: "Too Many Requests", detail: "Too Many Requests", status: 429 } } });
    await expect(adapter().publishPost!(account, { text: "x" })).rejects.toMatchObject({ code: "rate_limited" });
    installFakeTwitter({ postError: { status: 402, body: { title: "CreditsDepleted", detail: "Your enrolled account does not have any credits to fulfill this request.", status: 402 } } });
    const error = await adapter().publishPost!(account, { text: "x" }).catch((e) => e);
    expect(error).toMatchObject({ code: "publish_failed" });
    expect(error.details.providerMessage).toContain("credits");
  });

  it("posts the first comment as a reply under the post", async () => {
    const { posts } = installFakeTwitter();
    const result = await adapter().publishComment!(account, { externalPostId: "1900000000000000001", text: "Link in the replies: https://example.com" });
    expect(result.externalCommentId).toBe(posts[0]!.id);
    expect(posts[0]!.body).toEqual({ text: "Link in the replies: https://example.com", reply: { in_reply_to_tweet_id: "1900000000000000001" } });
    await expect(adapter().publishComment!(account, { externalPostId: "1", text: "a".repeat(281) })).rejects.toMatchObject({ code: "publish_failed" });
  });
});

describe("X adapter: numbers", () => {
  it("asks X for nothing unless collecting is switched on", async () => {
    const { fetchMock } = installFakeTwitter();
    const result = await adapter().collectMetrics!(account, { postIds: ["1900000000000000001"] });
    expect(result.account).toEqual({});
    expect(result.posts).toEqual({});
    expect(result.notes[0]).toMatchObject({ code: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads followers and per-post numbers when switched on, leaving unreported values empty", async () => {
    vi.stubEnv("TWITTER_ANALYTICS_ENABLED", "true");
    const { reads } = installFakeTwitter({ metrics: { "1900000000000000001": { retweet_count: 3, reply_count: 2, like_count: 40, quote_count: 1, bookmark_count: 5, impression_count: 900 } } });
    const result = await adapter().collectMetrics!(account, { postIds: ["1900000000000000001", "1900000000000000002"] });
    expect(result.account).toMatchObject({ followers: 1200, mediaCount: 87 });
    expect(result.posts).toEqual({ "1900000000000000001": { likes: 40, comments: 2, shares: 4, impressions: 900, saves: 5 } });
    expect(reads).toEqual(["users/me?public_metrics", "tweets?2"]);
  });
});

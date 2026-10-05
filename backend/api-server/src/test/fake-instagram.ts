import { vi } from "vitest";

// A minimal fake of the Instagram (Instagram Login) API endpoints the
// adapter uses, so the OAuth flow can be exercised without real credentials.

export interface FakeInstagramOptions {
  permissions?: string[];
  profile?: { user_id?: string; username?: string; name?: string; account_type?: string; profile_picture_url?: string | null };
  // api.instagram.com/oauth/access_token uses a flat error body
  // ({error_type, code, error_message}), unlike graph.instagram.com's
  // nested Graph-API-style {error: {...}} shape used by the other three
  // options below. Mixing these up is exactly the bug this fake caught.
  shortLivedError?: { error_type: string; code: number; error_message: string };
  longLivedError?: { code: number; message: string };
  meError?: { code: number; error_subcode?: number; message: string };
  refreshError?: { code: number; message: string };
}

// Instagram's real user_id is a bare JSON *number*, not a string (both from
// the token exchange and from /me) — this default is a real captured value,
// 17 digits, past Number.MAX_SAFE_INTEGER (16 digits). Built as raw JSON
// text below (not JSON.stringify of a JS object) specifically so the digits
// stay exact and never pass through a JS `number` at all in the fake,
// matching how the real HTTP response looks on the wire.
export const DEFAULT_PROFILE = {
  user_id: "28524542100518920",
  username: "acme.bakery",
  name: "Acme Bakery",
  account_type: "BUSINESS",
  profile_picture_url: "https://example.test/ig-avatar.png",
};

export const ALL_PERMISSIONS = ["instagram_business_basic", "instagram_business_content_publish"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function jsonRaw(text: string, status = 200) {
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

export function installFakeInstagram(options: FakeInstagramOptions = {}) {
  const permissions = options.permissions ?? ALL_PERMISSIONS;
  const profile = { ...DEFAULT_PROFILE, ...options.profile };
  const calls: URL[] = [];

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    calls.push(url);

    if (url.hostname === "api.instagram.com" && url.pathname === "/oauth/access_token") {
      if (options.shortLivedError) return json(options.shortLivedError, 400);
      return jsonRaw(`{"access_token":"IG_SHORT_LIVED","user_id":${profile.user_id},"permissions":${JSON.stringify(permissions)}}`);
    }
    if (url.hostname === "graph.instagram.com" && url.pathname === "/access_token") {
      if (options.longLivedError) return json({ error: options.longLivedError }, 400);
      return json({ access_token: "IG_LONG_LIVED", token_type: "bearer", expires_in: 5184000 });
    }
    if (url.hostname === "graph.instagram.com" && url.pathname === "/refresh_access_token") {
      if (options.refreshError) return json({ error: options.refreshError }, 400);
      return json({ access_token: "IG_REFRESHED", token_type: "bearer", expires_in: 5184000 });
    }
    if (url.hostname === "graph.instagram.com" && url.pathname === "/me") {
      if (options.meError) return json({ error: options.meError }, 400);
      return jsonRaw(
        `{"user_id":${profile.user_id},"username":${JSON.stringify(profile.username)},"name":${JSON.stringify(profile.name)},"account_type":${JSON.stringify(profile.account_type)},"profile_picture_url":${JSON.stringify(profile.profile_picture_url)}}`,
      );
    }
    return json({ error: { code: 803, message: "Unknown path" } }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

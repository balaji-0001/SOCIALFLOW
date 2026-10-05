import { vi } from "vitest";

// A minimal fake of the Google OAuth + YouTube Data API v3 endpoints the
// adapter uses, so the flow can be exercised without real credentials.

export interface FakeYouTubeOptions {
  tokenError?: { error: string; error_description: string };
  scope?: string[];
  includeRefreshToken?: boolean;
  channels?: Array<{ id: string; title: string; customUrl?: string | null; thumbnail?: string | null }>;
  tokeninfoError?: number;
  tokeninfoScope?: string[];
}

export const DEFAULT_CHANNELS = [{ id: "UC_test_channel_1", title: "Acme Studio", customUrl: "@acmestudio", thumbnail: "https://example.test/yt-avatar.png" }];
export const ALL_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function normalizeUrl(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
}

export function installFakeYouTube(options: FakeYouTubeOptions = {}) {
  const scope = options.scope ?? ALL_SCOPES;
  const channels = options.channels ?? DEFAULT_CHANNELS;
  const calls: Array<{ url: URL; body: URLSearchParams | null }> = [];

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = normalizeUrl(input);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    calls.push({ url, body });

    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      if (options.tokenError) return json(options.tokenError, 400);
      const responseBody: Record<string, unknown> = { access_token: "GOOG_ACCESS_TOKEN", expires_in: 3599, scope: scope.join(" ") };
      if (options.includeRefreshToken !== false) responseBody.refresh_token = "GOOG_REFRESH_TOKEN";
      return json(responseBody);
    }
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/tokeninfo") {
      if (options.tokeninfoError) return json({ error: "invalid_token" }, options.tokeninfoError);
      return json({ scope: (options.tokeninfoScope ?? scope).join(" "), expires_in: 3599 });
    }
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/revoke") {
      return json({});
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/channels") {
      return json({
        items: channels.map((c) => ({
          id: c.id,
          snippet: { title: c.title, customUrl: c.customUrl ?? null, thumbnails: { default: { url: c.thumbnail ?? null } } },
        })),
      });
    }
    return json({ error: { message: "Unknown path" } }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

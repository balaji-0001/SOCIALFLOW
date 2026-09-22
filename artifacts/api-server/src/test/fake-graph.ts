import { vi } from "vitest";

// A minimal fake of the Facebook Graph API endpoints the adapter uses, so the
// OAuth flow can be exercised end to end without real credentials.

export interface FakeGraphOptions {
  granted?: string[];
  declined?: string[];
  pages?: Array<{ id: string; name: string; access_token: string; tasks?: string[] }>;
  tokenExchangeError?: { code: number; error_subcode?: number; message: string };
  debugToken?: Record<string, unknown>;
  pageError?: { code: number; error_subcode?: number; message: string };
}

export const DEFAULT_PAGES = [
  { id: "1001", name: "Acme Bakery", access_token: "PAGE_TOKEN_1001", tasks: ["MANAGE", "CREATE_CONTENT"] },
  { id: "1002", name: "Acme Fans", access_token: "PAGE_TOKEN_1002", tasks: ["ANALYZE"] },
];

export const ALL_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function installFakeGraph(options: FakeGraphOptions = {}) {
  const granted = options.granted ?? ALL_SCOPES;
  const pages = options.pages ?? DEFAULT_PAGES;
  const calls: URL[] = [];

  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    calls.push(url);
    if (url.hostname !== "graph.facebook.com") throw new Error(`Unexpected request to ${url.hostname}`);
    const path = url.pathname.replace(/^\/v\d+\.\d+/, "");

    if (path === "/oauth/access_token") {
      if (options.tokenExchangeError) return json({ error: options.tokenExchangeError }, 400);
      if (url.searchParams.get("grant_type") === "fb_exchange_token") {
        return json({ access_token: "LONG_LIVED_USER_TOKEN", token_type: "bearer", expires_in: 5183944 });
      }
      return json({ access_token: "SHORT_LIVED_USER_TOKEN", token_type: "bearer", expires_in: 3600 });
    }
    if (path === "/me") return json({ id: "fb-user-42", name: "Test User" });
    if (path === "/me/permissions") {
      return json({
        data: [
          ...granted.map((permission) => ({ permission, status: "granted" })),
          ...(options.declined ?? []).map((permission) => ({ permission, status: "declined" })),
        ],
      });
    }
    if (path === "/me/accounts") return json({ data: pages, paging: {} });
    if (path === "/debug_token") {
      return json({
        data: options.debugToken ?? { is_valid: true, expires_at: 0, scopes: granted, app_id: "test-app-id" },
      });
    }
    const pageMatch = pages.find((p) => path === `/${p.id}`);
    if (pageMatch) {
      if (options.pageError) return json({ error: options.pageError }, 400);
      return json({ id: pageMatch.id, name: pageMatch.name, picture: { data: { url: "https://example.test/p.png" } } });
    }
    return json({ error: { code: 803, message: "Unknown path" } }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

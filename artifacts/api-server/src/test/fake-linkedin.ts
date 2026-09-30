import { vi } from "vitest";

// A minimal fake of the LinkedIn OAuth + REST API endpoints the adapter
// uses, so the flow can be exercised without real credentials.

export interface FakeLinkedInOptions {
  tokenError?: { error: string; error_description: string };
  scope?: string[];
  includeRefreshToken?: boolean;
  profile?: { sub?: string; name?: string; picture?: string | null };
  userinfoStatus?: number;
  administeredOrgs?: Array<{ id: string; name?: string }>;
  orgAclsStatus?: number;
  /** Status for POST /v2/ugcPosts (201 by default). */
  publishStatus?: number;
  publishError?: { message: string; status?: number; serviceErrorCode?: number };
}

export const DEFAULT_PROFILE = { sub: "li-member-123", name: "Jordan Lee", picture: "https://example.test/li-avatar.png" };
export const ALL_SCOPES = ["openid", "profile", "w_member_social"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function normalizeUrl(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
}

export function installFakeLinkedIn(options: FakeLinkedInOptions = {}) {
  const scope = options.scope ?? ALL_SCOPES;
  const profile = { ...DEFAULT_PROFILE, ...options.profile };
  const calls: Array<{ url: URL; body: URLSearchParams | null }> = [];
  const ugcPosts: Array<{ headers: Headers; body: Record<string, any> }> = [];

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = normalizeUrl(input);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    calls.push({ url, body });

    if (url.hostname === "www.linkedin.com" && url.pathname === "/oauth/v2/accessToken") {
      if (options.tokenError) return json(options.tokenError, 400);
      const responseBody: Record<string, unknown> = { access_token: "LI_ACCESS_TOKEN", expires_in: 5184000, scope: scope.join(" ") };
      if (options.includeRefreshToken !== false) {
        responseBody.refresh_token = "LI_REFRESH_TOKEN";
        responseBody.refresh_token_expires_in = 31536000;
      }
      return json(responseBody);
    }
    if (url.hostname === "api.linkedin.com" && url.pathname === "/v2/ugcPosts" && init?.method === "POST") {
      ugcPosts.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      if (options.publishError) return json(options.publishError, options.publishStatus ?? 422);
      return json({ id: "urn:li:share:7000000000000000001" }, 201);
    }
    if (url.hostname === "api.linkedin.com" && url.pathname === "/v2/userinfo") {
      if (options.userinfoStatus) return json({ message: "Invalid access token" }, options.userinfoStatus);
      return json({ sub: profile.sub, name: profile.name, picture: profile.picture });
    }
    if (url.hostname === "api.linkedin.com" && url.pathname === "/rest/organizationAcls") {
      if (options.orgAclsStatus) return json({ message: "forbidden" }, options.orgAclsStatus);
      const orgs = options.administeredOrgs ?? [];
      if (url.searchParams.get("q") === "roleAssignee") {
        return json({
          elements: orgs.map((o) => ({ role: "ADMINISTRATOR", organization: `urn:li:organization:${o.id}`, roleAssignee: "urn:li:person:x", state: "APPROVED" })),
        });
      }
      if (url.searchParams.get("q") === "organization") {
        const id = url.searchParams.get("organization")?.match(/urn:li:organization:(\d+)/)?.[1];
        const found = orgs.find((o) => o.id === id);
        return json({ elements: found ? [{ role: "ADMINISTRATOR", organization: `urn:li:organization:${id}`, state: "APPROVED" }] : [] });
      }
      return json({ elements: [] });
    }
    if (url.hostname === "api.linkedin.com" && url.pathname.startsWith("/rest/organizations/")) {
      const id = url.pathname.split("/").pop();
      const found = (options.administeredOrgs ?? []).find((o) => o.id === id);
      return json({ localizedName: found?.name ?? `Org ${id}` });
    }
    return json({ message: "Unknown path" }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls, ugcPosts };
}

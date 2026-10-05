import { vi } from "vitest";

// A minimal fake of the X (Twitter) OAuth 2.0 and API v2 endpoints the adapter uses, so the flow can be
// exercised without real credentials. Refresh tokens work once, as on X: each refresh retires the token it used.

export interface FakeTwitterOptions {
  tokenError?: { status?: number; body: Record<string, unknown> };
  /** Scopes the token answer lists. `null` leaves the field out. */
  scope?: string[] | null;
  user?: { id: string; name: string; username: string; profile_image_url?: string | null; subscription_type?: string };
  /** Status for GET /2/users/me (default 200). */
  meStatus?: number;
  /** Makes POST /2/tweets fail. */
  postError?: { status: number; body: Record<string, unknown> };
  /** States the STATUS call walks through after a video or GIF is finalised. */
  processing?: Array<"pending" | "in_progress" | "succeeded" | "failed">;
  metrics?: Record<string, Record<string, number>>;
}

export const TWITTER_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];
export const DEFAULT_TWITTER_USER = { id: "2244994945", name: "Acme Studio", username: "acmestudio", profile_image_url: "https://example.test/x-avatar.png", subscription_type: "None" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function installFakeTwitter(options: FakeTwitterOptions = {}) {
  const user = options.user ?? DEFAULT_TWITTER_USER;
  const tokenCalls: Array<{ body: URLSearchParams; authorization: string | null }> = [];
  const posts: Array<{ id: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const uploads: Array<{ id: string; init: Record<string, unknown>; segments: Array<{ index: number; bytes: number }>; finalized: boolean }> = [];
  const reads: string[] = [];
  const pending = new Map<string, string[]>();
  let issued = 0;
  let liveRefreshToken: string | null = null;

  const issue = () => {
    issued += 1;
    liveRefreshToken = `X_REFRESH_${issued}`;
    const body: Record<string, unknown> = { token_type: "bearer", expires_in: 7200, access_token: `X_ACCESS_${issued}`, refresh_token: liveRefreshToken };
    if (options.scope !== null) body.scope = (options.scope ?? TWITTER_SCOPES).join(" ");
    return body;
  };

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.hostname !== "api.x.com") return json({ title: "Unknown host" }, 404);

    if (url.pathname === "/2/oauth2/token") {
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
      tokenCalls.push({ body, authorization: headers.get("authorization") });
      if (options.tokenError) return json(options.tokenError.body, options.tokenError.status ?? 400);
      if (body.get("grant_type") === "refresh_token") {
        if (body.get("refresh_token") !== liveRefreshToken) return json({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, 400);
        return json(issue());
      }
      return json(issue());
    }

    if (url.pathname === "/2/users/me") {
      reads.push(`users/me?${url.searchParams.get("user.fields") ?? ""}`);
      if (options.meStatus && options.meStatus !== 200) return json({ title: options.meStatus === 401 ? "Unauthorized" : "Forbidden", detail: options.meStatus === 401 ? "Unauthorized" : "You are not permitted to perform this action.", status: options.meStatus }, options.meStatus);
      return json({ data: { ...user, public_metrics: { followers_count: 1200, following_count: 30, tweet_count: 87, listed_count: 2 } } });
    }

    if (url.pathname === "/2/tweets" && method === "POST") {
      if (options.postError) return json(options.postError.body, options.postError.status);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const id = `19000000000000000${String(posts.length + 1).padStart(2, "0")}`;
      posts.push({ id, body, authorization: headers.get("authorization") });
      return json({ data: { id, text: body.text, edit_history_tweet_ids: [id] } }, 201);
    }

    if (url.pathname === "/2/tweets" && method === "GET") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      reads.push(`tweets?${ids.length}`);
      return json({ data: ids.filter((id) => options.metrics?.[id]).map((id) => ({ id, public_metrics: options.metrics![id] })) });
    }

    if (url.pathname === "/2/media/upload/initialize" && method === "POST") {
      const init_ = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const id = `77000000000000000${uploads.length + 1}`;
      uploads.push({ id, init: init_, segments: [], finalized: false });
      return json({ data: { id, media_key: `3_${id}`, expires_after_secs: 86400 } });
    }

    const append = /^\/2\/media\/upload\/(\d+)\/append$/.exec(url.pathname);
    if (append && method === "POST") {
      const upload = uploads.find((item) => item.id === append[1]);
      const form = init?.body as FormData;
      const media = form.get("media") as Blob;
      upload?.segments.push({ index: Number(form.get("segment_index")), bytes: media.size });
      return json({ data: { expires_at: Date.now() + 86_400_000 } });
    }

    const finalize = /^\/2\/media\/upload\/(\d+)\/finalize$/.exec(url.pathname);
    if (finalize && method === "POST") {
      const upload = uploads.find((item) => item.id === finalize[1])!;
      upload.finalized = true;
      const needsProcessing = upload.init.media_category !== "tweet_image";
      if (needsProcessing) pending.set(upload.id, [...(options.processing ?? ["succeeded"])]);
      return json({ data: { id: upload.id, media_key: `3_${upload.id}`, ...(needsProcessing ? { processing_info: { state: "pending", check_after_secs: 1 } } : {}) } });
    }

    if (url.pathname === "/2/media/upload" && url.searchParams.get("command") === "STATUS") {
      const id = url.searchParams.get("media_id")!;
      const states = pending.get(id) ?? ["succeeded"];
      const state = states.length > 1 ? states.shift()! : states[0]!;
      return json({ data: { id, processing_info: { state, ...(state === "succeeded" ? { progress_percent: 100 } : state === "failed" ? { error: { message: "InvalidMedia" } } : { check_after_secs: 1 }) } } });
    }

    return json({ title: "Not Found Error", detail: "Unknown path", status: 404 }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, tokenCalls, posts, uploads, reads };
}

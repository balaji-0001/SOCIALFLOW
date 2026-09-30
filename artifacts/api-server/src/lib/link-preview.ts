import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/*
 * Link previews: fetch a page on the user's behalf and read its Open Graph / Twitter / basic tags.
 *
 * The server fetches a URL the user typed, so this is a server-side request forgery (SSRF) surface. Defences:
 * http/https only, ports 80/443 only, no credentials in the URL, the hostname is resolved by us and every address
 * must be public (loopback, private, link-local, CGNAT, metadata, multicast, reserved and IPv6-local ranges are
 * refused), the connection is pinned to the address we validated (no second DNS lookup), every redirect hop is
 * validated the same way (max 4), 5 s overall timeout, and the body is streamed and capped.
 */

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  /** The page's preferred picture (the first of imageUrls). */
  imageUrl: string | null;
  /** Every picture the page offers for previews, best first, so the user can pick another. */
  imageUrls: string[];
  siteName: string | null;
  fetchedAt: string;
};

export type LinkPreviewErrorCode = "invalid_url" | "no_preview" | "fetch_failed";

export class LinkPreviewError extends Error {
  constructor(public readonly code: LinkPreviewErrorCode, message: string) {
    super(message);
    this.name = "LinkPreviewError";
  }
}

export const USER_AGENT = "SocialFlowLinkPreview/1.0";
export const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 5_000;
const MAX_HTML_BYTES = 1_572_864; // 1.5 MB
const CACHE_SIZE = 200;
const MAX_IMAGES = 8;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 1000;

/* ---------- address checks ---------- */

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToInt(base);
    return value >= start && value < start + size;
  });
}

/** Expands an IPv6 address into 8 groups of 16 bits, or null if it doesn't parse. */
function expandV6(input: string): number[] | null {
  let ip = input.split("%")[0]!;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (tail) {
    if (!net.isIPv4(tail[1]!)) return null;
    const n = ipv4ToInt(tail[1]!);
    ip = ip.slice(0, ip.length - tail[1]!.length) + `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill("0") : []), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True when the address must never be fetched (anything that isn't a plain public unicast address). Unparseable = blocked. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (!net.isIPv6(ip)) return true;
  const g = expandV6(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isBlockedV4(v4FromGroups(g[6]!, g[7]!)); // ::ffff:a.b.c.d and ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return isBlockedV4(v4FromGroups(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return isBlockedV4(v4FromGroups(g[1]!, g[2]!)); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
  return false;
}

/* ---------- transport (replaceable in tests) ---------- */

export type HopResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
};

export type Resolved = { address: string; family: number };

export const linkPreviewDeps: {
  lookup: (hostname: string) => Promise<Resolved[]>;
  request: (url: URL, resolved: Resolved, headers: Record<string, string>, signal: AbortSignal) => Promise<HopResponse>;
} = {
  lookup: async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family })),
  request: (url, resolved, headers, signal) =>
    new Promise<HopResponse>((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          protocol: url.protocol,
          host: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers,
          // Connect to the address we validated instead of resolving the name again.
          lookup: (_host: string, options: unknown, callback: (...args: any[]) => void) => {
            if ((options as { all?: boolean } | undefined)?.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
            else callback(null, resolved.address, resolved.family);
          },
          signal,
        },
        (res) => {
          const headerMap: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(res.headers)) headerMap[key] = Array.isArray(value) ? value[0] : value;
          resolve({ status: res.statusCode ?? 0, headers: headerMap, body: res, destroy: () => res.destroy() });
        },
      );
      req.on("error", reject);
      req.end();
    }),
};

/* ---------- validated fetch ---------- */

/** Parses and checks the URL shape only (no network). Throws invalid_url. */
export function parseHttpUrl(raw: string): URL {
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH) throw new LinkPreviewError("invalid_url", "Enter a full link that starts with http:// or https://.");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new LinkPreviewError("invalid_url", "Enter a full link that starts with http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LinkPreviewError("invalid_url", "Only http:// and https:// links can be previewed.");
  if (url.username || url.password) throw new LinkPreviewError("invalid_url", "Links with a username or password can't be previewed.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new LinkPreviewError("invalid_url", "Only links on the standard web ports (80 and 443) can be previewed.");
  url.hash = "";
  return url;
}

async function resolvePublic(url: URL): Promise<Resolved> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const refuse = () => new LinkPreviewError("invalid_url", "That link points to a private or internal address, so it can't be previewed.");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw refuse();
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw refuse();
    return { address: host, family: net.isIPv6(host) ? 6 : 4 };
  }
  let addresses: Resolved[];
  try {
    addresses = await linkPreviewDeps.lookup(host);
  } catch {
    throw new LinkPreviewError("fetch_failed", "That website's address couldn't be found. Check the link.");
  }
  if (addresses.length === 0) throw new LinkPreviewError("fetch_failed", "That website's address couldn't be found. Check the link.");
  // Every address must be public: a name that also points at an internal address is refused outright.
  if (addresses.some((a) => isBlockedAddress(a.address))) throw refuse();
  return addresses[0]!;
}

export type SafeGetOptions = {
  accept: string;
  maxBytes: number;
  /** Decides from the Content-Type whether the body may be read. */
  allowType: (contentType: string) => boolean;
  wrongTypeMessage: string;
  /** "truncate" keeps what was read once the cap is hit (page heads are enough); "fail" refuses oversized bodies. */
  onOverflow: "truncate" | "fail";
  timeoutMs?: number;
};

export type SafeGetResult = { finalUrl: string; contentType: string; body: Buffer };

/** GETs a public web URL with every SSRF protection applied on each hop. Throws LinkPreviewError. */
export async function safeGet(rawUrl: string, options: SafeGetOptions): Promise<SafeGetResult> {
  let url = parseHttpUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  let active: HopResponse | null = null;
  // The deadline covers connecting and reading, whatever the transport does with the abort signal.
  const deadline = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
  deadline.catch(() => {});
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const resolved = await resolvePublic(url);
      active = await Promise.race([linkPreviewDeps.request(url, resolved, { "user-agent": USER_AGENT, accept: options.accept, "accept-encoding": "identity" }, controller.signal), deadline]);
      const { status, headers } = active;
      if ([301, 302, 303, 307, 308].includes(status)) {
        active.destroy();
        active = null;
        const location = headers.location;
        if (!location) throw new LinkPreviewError("fetch_failed", "The website redirected without saying where.");
        if (hop === MAX_REDIRECTS) throw new LinkPreviewError("fetch_failed", "The website redirected too many times.");
        try {
          url = parseHttpUrl(new URL(location, url).toString());
        } catch (error) {
          if (error instanceof LinkPreviewError) throw new LinkPreviewError("fetch_failed", `The website redirected somewhere that can't be previewed. ${error.message}`);
          throw error;
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        active.destroy();
        throw new LinkPreviewError("fetch_failed", `The website answered with an error (${status}).`);
      }
      const contentType = (headers["content-type"] ?? "").toLowerCase();
      if (!options.allowType(contentType)) {
        active.destroy();
        throw new LinkPreviewError("fetch_failed", options.wrongTypeMessage);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = active.body[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([reader.next(), deadline]);
        if (next.done) break;
        const buffer = Buffer.from(next.value);
        if (total + buffer.length > options.maxBytes) {
          if (options.onOverflow === "fail") {
            active.destroy();
            throw new LinkPreviewError("fetch_failed", "The file is too large.");
          }
          chunks.push(buffer.subarray(0, options.maxBytes - total));
          total = options.maxBytes;
          active.destroy();
          break;
        }
        chunks.push(buffer);
        total += buffer.length;
      }
      return { finalUrl: url.toString(), contentType, body: Buffer.concat(chunks) };
    }
    throw new LinkPreviewError("fetch_failed", "The website redirected too many times.");
  } catch (error) {
    active?.destroy();
    if (error instanceof LinkPreviewError) throw error;
    if (controller.signal.aborted) throw new LinkPreviewError("fetch_failed", "The website took too long to answer.");
    throw new LinkPreviewError("fetch_failed", "The website couldn't be reached.");
  } finally {
    clearTimeout(timer);
  }
}

/** Downloads a public image with the same protections (used for the LinkedIn card thumbnail). Throws LinkPreviewError. */
export async function fetchPublicImage(rawUrl: string, maxBytes = 5 * 1024 * 1024): Promise<{ bytes: Buffer; mimeType: string }> {
  const result = await safeGet(rawUrl, {
    accept: "image/jpeg,image/png,image/gif,image/*;q=0.5",
    maxBytes,
    allowType: (type) => /^image\/(jpeg|png|gif|webp)\b/.test(type),
    wrongTypeMessage: "The link isn't a JPG, PNG, GIF or WebP image.",
    onOverflow: "fail",
  });
  return { bytes: result.body, mimeType: result.contentType.split(";")[0]!.trim() };
}

/* ---------- parsing ---------- */

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]!.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const clean = (text: string | undefined, max: number): string | null => {
  if (!text) return null;
  const value = decodeEntities(text).replace(/\s+/g, " ").trim();
  return value ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : null;
};

function metaTags(html: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    const key = (attrs.property ?? attrs.name)?.toLowerCase();
    if (!key || attrs.content === undefined) continue;
    map.set(key, [...(map.get(key) ?? []), attrs.content]);
  }
  return map;
}

/** http(s) only, absolute, resolved against the page URL. */
function resolveHttpUrl(value: string | undefined, base: string): string | null {
  const text = value ? decodeEntities(value).trim() : "";
  if (!text) return null;
  try {
    const url = new URL(text, base);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.toString().length > MAX_URL_LENGTH) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Reads the preview fields out of a page's HTML. Pure; no network. */
export function parsePreviewHtml(rawHtml: string, pageUrl: string): Omit<LinkPreview, "url" | "fetchedAt"> {
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, "");
  const meta = metaTags(html);
  const first = (...keys: string[]) => {
    for (const key of keys) for (const value of meta.get(key) ?? []) if (value.trim()) return value;
    return undefined;
  };
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  const title = clean(first("og:title", "twitter:title") ?? titleTag, MAX_TITLE);
  const description = clean(first("og:description", "twitter:description", "description"), MAX_DESCRIPTION);
  const siteName = clean(first("og:site_name", "application-name"), 200);

  const candidates = [first("og:image:secure_url"), ...(meta.get("og:image") ?? []), ...(meta.get("twitter:image") ?? []), ...(meta.get("twitter:image:src") ?? [])]
    .map((value) => resolveHttpUrl(value, pageUrl))
    .filter((value): value is string => Boolean(value));
  // https first, then in page order, without repeats; capped so a gallery page can't send hundreds.
  const imageUrls = [...new Set([...candidates.filter((value) => value.startsWith("https:")), ...candidates])].slice(0, MAX_IMAGES);
  const imageUrl = imageUrls[0] ?? null;

  return { title, description, imageUrl, imageUrls, siteName };
}

function decodeBody(body: Buffer, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString("latin1"))?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/* ---------- cache + entry point ---------- */

const cache = new Map<string, { at: number; value: LinkPreview }>();

export function clearLinkPreviewCache(): void {
  cache.clear();
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview> {
  const requested = parseHttpUrl(rawUrl).toString();
  const hit = cache.get(requested);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(requested);
    cache.set(requested, hit);
    return hit.value;
  }
  const page = await safeGet(requested, {
    accept: "text/html,application/xhtml+xml",
    maxBytes: MAX_HTML_BYTES,
    allowType: (type) => /^(text\/html|application\/xhtml\+xml)\b/.test(type),
    wrongTypeMessage: "That link isn't a web page (it doesn't return HTML), so there is nothing to preview.",
    onOverflow: "truncate",
  });
  const parsed = parsePreviewHtml(decodeBody(page.body, page.contentType), page.finalUrl);
  if (!parsed.title && !parsed.description && !parsed.imageUrl) {
    throw new LinkPreviewError("no_preview", "That page doesn't have a title, description or image to show. You can still post the link as text.");
  }
  const value: LinkPreview = { url: page.finalUrl, ...parsed, fetchedAt: new Date().toISOString() };
  cache.set(requested, { at: Date.now(), value });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return value;
}

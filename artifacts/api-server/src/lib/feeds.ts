import { XMLParser } from "fast-xml-parser";
import net from "node:net";
import { isBlockedAddress, LinkPreviewError, MAX_URL_LENGTH, parseHttpUrl, safeGet } from "./link-preview";

/*
 * Reading automation sources: RSS 2.0 / RSS 1.0 / Atom feeds, and WordPress sites through their public REST API
 * (falling back to the site's /feed/ when the API is off). Every request goes through safeGet, so the SSRF rules
 * of link previews apply (public addresses only, ports 80/443, validated redirects, timeout, size cap).
 * Parsing is pure and tested with fixtures; nothing here touches the database.
 */

export type FeedItem = {
  /** Stable identity for duplicate protection: guid / id, else the link, normalised. */
  key: string;
  title: string;
  url: string | null;
  publishedAt: Date | null;
  imageUrl: string | null;
  excerpt: string;
  author: string | null;
};

export type FeedResult = { sourceTitle: string | null; items: FeedItem[] };

export type FeedErrorCode = "invalid_url" | "not_a_source" | "fetch_failed";

export class FeedError extends Error {
  constructor(public readonly code: FeedErrorCode, message: string) {
    super(message);
    this.name = "FeedError";
  }
}

export type SourceKind = "wordpress" | "rss";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_ITEMS = 50;
const MAX_TITLE = 300;
const MAX_EXCERPT = 1_000;
const MAX_KEY = 500;

/* ---------- text helpers ---------- */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢",
  deg: "°", middot: "·", bull: "•", times: "×", divide: "÷", sect: "§", para: "¶", iexcl: "¡", iquest: "¿", shy: "",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", aacute: "á", agrave: "à", acirc: "â", auml: "ä", atilde: "ã", aring: "å",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", oacute: "ó", ograve: "ò", ocirc: "ô", ouml: "ö", otilde: "õ", oslash: "ø",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", ntilde: "ñ", ccedil: "ç", szlig: "ß", Eacute: "É", Aacute: "Á", Oacute: "Ó",
  Uacute: "Ú", Ntilde: "Ñ", Ccedil: "Ç", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", aelig: "æ", AElig: "Æ", thinsp: " ", ensp: " ", emsp: " ",
  zwj: "", zwnj: "", lrm: "", rlm: "", sbquo: "‚", bdquo: "„", prime: "′", Prime: "″", frac12: "½", frac14: "¼", frac34: "¾",
};

/** Decodes named and numeric character references. Unknown names are left as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]!.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      } catch {
        return whole;
      }
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole;
  });
}

/** HTML to plain text: drops scripts, styles and tags, decodes entities and collapses whitespace. */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|iframe|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|blockquote)\s*>/gi, " ");
  return decodeEntities(withoutBlocks.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Shortens text at a word boundary, ending with an ellipsis. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** WordPress excerpts end in "[…]" or a "Continue reading" link; neither belongs in a social post. */
function cleanExcerpt(text: string): string {
  return text.replace(/\s*(\[(…|&hellip;|\.\.\.)\]|Continue reading.*|Read more.*)$/i, "").trim();
}

function httpUrl(value: string | null | undefined, base?: string): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(decodeEntities(text), base);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.toString().length > MAX_URL_LENGTH) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A stable key: URLs lose their fragment, trailing slash and host case; anything else is trimmed. */
export function normalizeItemKey(raw: string): string {
  const text = raw.trim();
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.hash = "";
      let out = `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
      if (!out) out = url.host.toLowerCase();
      return out.slice(0, MAX_KEY);
    }
  } catch { /* not a URL: use as is */ }
  return text.slice(0, MAX_KEY);
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

const firstImageInHtml = (html: string | null, base: string): string | null => {
  if (!html) return null;
  const match = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(html);
  return match ? httpUrl(match[1] ?? match[2], base) : null;
};

/* ---------- XML (RSS / Atom) ---------- */

type Node = Record<string, unknown>;

const ARRAY_TAGS = new Set(["item", "entry", "link", "enclosure", "media:content", "media:thumbnail", "media:group", "category", "author"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Entities are decoded by us (decodeEntities) so a DOCTYPE can never expand anything.
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

/** The text inside a node, whatever shape the parser gave it. XML entities are decoded once. */
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "string") return decodeEntities(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") return text((value as Node)["#text"]);
  return null;
}

const attr = (node: unknown, name: string): string | null => {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const value = (node as Node)[`@_${name}`];
  return typeof value === "string" ? decodeEntities(value) : null;
};

const list = (value: unknown): unknown[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

function mediaImage(node: Node, base: string): string | null {
  const isImage = (candidate: unknown) => {
    const type = attr(candidate, "type") ?? "";
    const medium = attr(candidate, "medium") ?? "";
    const url = attr(candidate, "url") ?? "";
    return medium === "image" || type.startsWith("image/") || (!type && !medium && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url));
  };
  const groups = list(node["media:group"]) as Node[];
  const contents = [...list(node["media:content"]), ...groups.flatMap((group) => list(group?.["media:content"]))];
  const thumbs = [...list(node["media:thumbnail"]), ...groups.flatMap((group) => list(group?.["media:thumbnail"]))];
  for (const candidate of list(node.enclosure)) if (isImage(candidate)) { const url = httpUrl(attr(candidate, "url"), base); if (url) return url; }
  for (const candidate of contents) if (isImage(candidate)) { const url = httpUrl(attr(candidate, "url"), base); if (url) return url; }
  for (const candidate of thumbs) { const url = httpUrl(attr(candidate, "url"), base); if (url) return url; }
  return null;
}

function finishItems(items: Array<FeedItem | null>): FeedItem[] {
  const seen = new Set<string>();
  const kept: FeedItem[] = [];
  for (const item of items) {
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    kept.push(item);
    if (kept.length >= MAX_ITEMS) break;
  }
  // Newest first; items without a date keep their feed order (feeds already list newest first).
  return kept.map((item, index) => ({ item, index })).sort((a, b) => {
    const at = a.item.publishedAt?.getTime();
    const bt = b.item.publishedAt?.getTime();
    if (at !== undefined && bt !== undefined && at !== bt) return bt - at;
    return a.index - b.index;
  }).map(({ item }) => item);
}

function buildItem(fields: { id: string | null; link: string | null; title: string | null; date: string | null; summaryHtml: string | null; contentHtml: string | null; imageUrl: string | null; author: string | null }, base: string): FeedItem | null {
  const url = httpUrl(fields.link, base);
  const rawKey = fields.id?.trim() || url;
  if (!rawKey) return null;
  const title = truncateText(htmlToText(fields.title ?? ""), MAX_TITLE);
  const excerpt = truncateText(cleanExcerpt(htmlToText(fields.summaryHtml ?? fields.contentHtml ?? "")), MAX_EXCERPT);
  if (!title && !url && !excerpt) return null;
  return {
    key: normalizeItemKey(rawKey),
    title,
    url,
    publishedAt: parseDate(fields.date),
    imageUrl: fields.imageUrl ?? firstImageInHtml(fields.contentHtml, url ?? base) ?? firstImageInHtml(fields.summaryHtml, url ?? base),
    excerpt,
    author: fields.author ? truncateText(htmlToText(fields.author), 120) || null : null,
  };
}

/** Parses an RSS 2.0, RSS 1.0 (RDF) or Atom document. Throws FeedError("not_a_source") for anything else. */
export function parseFeedXml(xml: string, baseUrl: string): FeedResult {
  const notFeed = () => new FeedError("not_a_source", "That doesn't look like an RSS or Atom feed.");
  // Feeds never need entity declarations; refusing them rules out entity-expansion attacks entirely.
  if (/<!ENTITY/i.test(xml)) throw notFeed();
  let doc: Node;
  try {
    doc = parser.parse(xml.replace(/^﻿/, "")) as Node;
  } catch {
    throw notFeed();
  }
  if (!doc || typeof doc !== "object") throw notFeed();

  const rss = (doc.rss ?? doc["rdf:RDF"]) as Node | undefined;
  if (rss && typeof rss === "object") {
    const channel = (Array.isArray(rss.channel) ? rss.channel[0] : rss.channel) as Node | undefined;
    const rawItems = list(rss.item ?? channel?.item) as Node[];
    const channelLink = httpUrl(text(list(channel?.link).find((l) => typeof l === "string" || (l && typeof l === "object" && "#text" in (l as Node)))), baseUrl) ?? baseUrl;
    const items = rawItems.map((item) => buildItem({
      id: text(item.guid) ?? attr(item, "rdf:about"),
      link: text(list(item.link).find((l) => typeof l === "string" || (l && typeof l === "object" && "#text" in (l as Node)))),
      title: text(item.title),
      date: text(item.pubDate) ?? text(item["dc:date"]) ?? text(item.published) ?? text(item.updated),
      summaryHtml: text(item.description),
      contentHtml: text(item["content:encoded"]),
      imageUrl: mediaImage(item, channelLink),
      author: text(item["dc:creator"]) ?? text(item.author),
    }, channelLink));
    return { sourceTitle: channel ? truncateText(htmlToText(text(channel.title) ?? ""), 200) || null : null, items: finishItems(items) };
  }

  const feed = doc.feed as Node | undefined;
  if (feed && typeof feed === "object") {
    const items = (list(feed.entry) as Node[]).map((entry) => {
      const links = list(entry.link);
      const alternate = links.find((l) => { const rel = attr(l, "rel"); return !rel || rel === "alternate"; }) ?? links[0];
      const enclosure = links.find((l) => attr(l, "rel") === "enclosure" && (attr(l, "type") ?? "").startsWith("image/"));
      const author = list(entry.author)[0] as Node | undefined;
      return buildItem({
        id: text(entry.id),
        link: attr(alternate, "href"),
        title: text(entry.title),
        date: text(entry.published) ?? text(entry.updated),
        summaryHtml: text(entry.summary),
        contentHtml: text(entry.content),
        imageUrl: mediaImage(entry, baseUrl) ?? httpUrl(attr(enclosure, "href"), baseUrl),
        author: author && typeof author === "object" ? text(author.name) : text(author),
      }, baseUrl);
    });
    return { sourceTitle: truncateText(htmlToText(text(feed.title) ?? ""), 200) || null, items: finishItems(items) };
  }
  throw notFeed();
}

/* ---------- WordPress REST API ---------- */

/** Reads the items from a /wp-json/wp/v2/posts response (with _embed). Throws FeedError("not_a_source") if it isn't one. */
export function parseWordPressPosts(json: unknown, siteUrl: string): FeedItem[] {
  if (!Array.isArray(json)) throw new FeedError("not_a_source", "That doesn't look like a WordPress site.");
  const items = json.map((raw) => {
    if (!raw || typeof raw !== "object") return null;
    const post = raw as Record<string, any>;
    if (post.id === undefined || typeof post.link !== "string") return null;
    const embedded = (post._embedded ?? {}) as Record<string, any>;
    const media = Array.isArray(embedded["wp:featuredmedia"]) ? embedded["wp:featuredmedia"][0] : null;
    const author = Array.isArray(embedded.author) ? embedded.author[0] : null;
    const date = typeof post.date_gmt === "string" && post.date_gmt ? `${post.date_gmt.replace(/Z$/, "")}Z` : typeof post.date === "string" ? post.date : null;
    // guid.rendered is the same value the site's RSS feed uses as <guid>, so falling back to the feed keeps the same keys.
    const guid = typeof post.guid?.rendered === "string" && post.guid.rendered ? post.guid.rendered : `wp:${String(post.id)}`;
    return buildItem({
      id: guid,
      link: post.link,
      title: typeof post.title?.rendered === "string" ? post.title.rendered : null,
      date,
      summaryHtml: typeof post.excerpt?.rendered === "string" ? post.excerpt.rendered : null,
      contentHtml: typeof post.content?.rendered === "string" ? post.content.rendered : null,
      imageUrl: media && typeof media.source_url === "string" ? httpUrl(media.source_url, siteUrl) : null,
      author: author && typeof author.name === "string" ? author.name : null,
    }, siteUrl);
  });
  if (json.length > 0 && items.every((item) => item === null)) throw new FeedError("not_a_source", "That doesn't look like a WordPress site.");
  return finishItems(items);
}

/** "example.com/blog/" → "https://example.com/blog". Throws FeedError("invalid_url"). */
export function normalizeSiteUrl(raw: string): string {
  let text = raw.trim();
  if (text && !/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  const url = parseUrlOrThrow(text);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function parseUrlOrThrow(raw: string): URL {
  let url: URL;
  try {
    url = parseHttpUrl(raw);
  } catch (error) {
    throw new FeedError("invalid_url", error instanceof Error ? error.message : "Enter a full link that starts with http:// or https://.");
  }
  // Addresses that are plainly internal are refused when saved, not only when fetched (every fetch re-checks what the name resolves to).
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || (net.isIP(host) !== 0 && isBlockedAddress(host))) {
    throw new FeedError("invalid_url", "That address points to a private or internal network, so it can't be used.");
  }
  return url;
}

/** Validates a feed or site URL's shape (http/https, standard ports, no credentials). Returns the cleaned URL. */
export function normalizeSourceUrl(kind: SourceKind, raw: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > MAX_URL_LENGTH) throw new FeedError("invalid_url", "Enter a full link that starts with http:// or https://.");
  if (kind === "wordpress") return normalizeSiteUrl(raw);
  return parseUrlOrThrow(raw.trim()).toString();
}

/* ---------- fetching ---------- */

const isXmlType = (type: string) => /(xml|rss|atom)/.test(type) || type.startsWith("text/plain") || type === "";
const isJsonType = (type: string) => /^application\/(json|[\w.+-]*\+json)\b/.test(type);

function decode(body: Buffer, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(body.subarray(0, 200).toString("latin1"))?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** Turns transport errors into FeedErrors: blocked addresses are invalid_url, everything else fetch_failed. */
function asFeedError(error: unknown): FeedError {
  if (error instanceof FeedError) return error;
  if (error instanceof LinkPreviewError) return new FeedError(error.code === "invalid_url" ? "invalid_url" : "fetch_failed", error.message);
  return new FeedError("fetch_failed", "The source couldn't be reached.");
}

async function fetchFeedAt(url: string): Promise<FeedResult> {
  const result = await safeGet(url, {
    accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1",
    maxBytes: MAX_BYTES,
    allowType: isXmlType,
    wrongTypeMessage: "That doesn't look like an RSS or Atom feed.",
    onOverflow: "fail",
    timeoutMs: TIMEOUT_MS,
  }).catch((error) => {
    const converted = asFeedError(error);
    if (converted.message === "That doesn't look like an RSS or Atom feed.") throw new FeedError("not_a_source", converted.message);
    throw converted;
  });
  return parseFeedXml(decode(result.body, result.contentType), result.finalUrl);
}

async function fetchJson(url: string, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const result = await safeGet(url, {
    accept: "application/json",
    maxBytes: MAX_BYTES,
    allowType: isJsonType,
    wrongTypeMessage: "not json",
    onOverflow: "fail",
    timeoutMs,
  });
  return JSON.parse(decode(result.body, result.contentType));
}

async function fetchWordPress(site: string): Promise<FeedResult> {
  let items: FeedItem[] | null = null;
  try {
    const json = await fetchJson(`${site}/wp-json/wp/v2/posts?per_page=10&orderby=date&order=desc&_embed=1&status=publish`);
    items = parseWordPressPosts(json, site);
  } catch (error) {
    // A blocked address is final; anything else (REST API off, 401/404, HTML instead of JSON) falls back to the feed.
    if (error instanceof LinkPreviewError && error.code === "invalid_url") throw asFeedError(error);
  }
  if (items) {
    let sourceTitle: string | null = null;
    try {
      const info = (await fetchJson(`${site}/wp-json/?_fields=name`, 5_000)) as { name?: unknown };
      if (typeof info?.name === "string") sourceTitle = truncateText(htmlToText(info.name), 200) || null;
    } catch { /* the name is a nicety */ }
    return { sourceTitle, items };
  }
  try {
    return await fetchFeedAt(`${site}/feed/`);
  } catch (error) {
    const converted = asFeedError(error);
    if (converted.code === "not_a_source") throw new FeedError("not_a_source", "That doesn't look like a WordPress site: its REST API and its /feed/ address didn't return posts.");
    if (converted.code === "fetch_failed" && /\((404|410)\)/.test(converted.message)) throw new FeedError("not_a_source", "That doesn't look like a WordPress site: its REST API and its /feed/ address didn't return posts.");
    throw converted;
  }
}

/** Fetches and parses a source. Throws FeedError with a message that can be shown to the user. */
export async function fetchSource(kind: SourceKind, rawUrl: string): Promise<FeedResult> {
  const url = normalizeSourceUrl(kind, rawUrl);
  try {
    return kind === "wordpress" ? await fetchWordPress(url) : await fetchFeedAt(url);
  } catch (error) {
    throw asFeedError(error);
  }
}

/** The HTTP status a FeedError maps to: 400 for a bad address, 422 for "not a feed", 502 for a site that failed. */
export function feedErrorStatus(error: FeedError): number {
  return error.code === "invalid_url" ? 400 : error.code === "not_a_source" ? 422 : 502;
}

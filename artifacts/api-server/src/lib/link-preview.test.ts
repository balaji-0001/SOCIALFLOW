import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LinkPreviewError,
  clearLinkPreviewCache,
  fetchLinkPreview,
  fetchPublicImage,
  isBlockedAddress,
  linkPreviewDeps,
  parsePreviewHtml,
  safeGet,
  type HopResponse,
} from "./link-preview";

const realDeps = { ...linkPreviewDeps };

function response(status: number, headers: Record<string, string>, body: string | Buffer | Buffer[] = ""): HopResponse {
  const chunks = Array.isArray(body) ? body : [Buffer.from(body)];
  return {
    status,
    headers,
    body: (async function* () { for (const chunk of chunks) yield chunk; })(),
    destroy: vi.fn(),
  };
}
const html = (body: string) => response(200, { "content-type": "text/html; charset=utf-8" }, body);
const PAGE = `<html><head><title>Fallback</title><meta property="og:title" content="Hello &amp; welcome"><meta property="og:image" content="/img/card.png"></head></html>`;

function stub(handler: (url: URL, headers: Record<string, string>) => HopResponse | Promise<HopResponse>, dns: Record<string, string[]> = {}) {
  const request = vi.fn(async (url: URL, _resolved: unknown, headers: Record<string, string>) => handler(url, headers));
  const lookup = vi.fn(async (host: string) => (dns[host] ?? ["93.184.216.34"]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  linkPreviewDeps.request = request as never;
  linkPreviewDeps.lookup = lookup;
  return { request, lookup };
}

beforeEach(() => clearLinkPreviewCache());
afterEach(() => Object.assign(linkPreviewDeps, realDeps));

describe("parsePreviewHtml", () => {
  it("reads Open Graph tags, decodes entities and resolves relative images", () => {
    const result = parsePreviewHtml(
      `<meta property="og:title" content="Tom &amp; Jerry"><meta property="og:description" content="A &#39;great&#39; page"><meta property="og:image" content="/a.png"><meta property="og:site_name" content="Acme">`,
      "https://example.com/blog/post",
    );
    expect(result).toEqual({ title: "Tom & Jerry", description: "A 'great' page", imageUrl: "https://example.com/a.png", imageUrls: ["https://example.com/a.png"], siteName: "Acme" });
  });

  it("prefers og:image:secure_url and https images", () => {
    const result = parsePreviewHtml(`<meta property="og:image" content="http://cdn.example.com/a.png"><meta property="og:image:secure_url" content="https://cdn.example.com/a.png">`, "https://example.com/");
    expect(result.imageUrl).toBe("https://cdn.example.com/a.png");
    expect(parsePreviewHtml(`<meta property="og:image" content="http://a.test/x.png"><meta name="twitter:image" content="https://b.test/y.png">`, "https://example.com/").imageUrl).toBe("https://b.test/y.png");
  });

  it("offers every distinct picture the page lists, https first, so the user can pick one", () => {
    const result = parsePreviewHtml(
      `<meta property="og:image" content="http://a.test/1.png"><meta property="og:image" content="https://a.test/2.png"><meta property="og:image" content="https://a.test/2.png"><meta name="twitter:image" content="https://a.test/3.png">`,
      "https://example.com/",
    );
    expect(result.imageUrls).toEqual(["https://a.test/2.png", "https://a.test/3.png", "http://a.test/1.png"]);
    expect(result.imageUrl).toBe("https://a.test/2.png");
    const many = Array.from({ length: 20 }, (_, i) => `<meta property="og:image" content="https://a.test/${i}.png">`).join("");
    expect(parsePreviewHtml(many, "https://example.com/").imageUrls).toHaveLength(8);
  });

  it("falls back to Twitter tags, then <title> and meta description", () => {
    expect(parsePreviewHtml(`<meta name="twitter:title" content="TW"><meta name="twitter:description" content="TD"><meta name='twitter:image' content='https://x.test/i.jpg'>`, "https://e.com")).toMatchObject({ title: "TW", description: "TD", imageUrl: "https://x.test/i.jpg" });
    expect(parsePreviewHtml(`<title>\n  Plain   title </title><meta name="description" content="Plain description">`, "https://e.com")).toMatchObject({ title: "Plain title", description: "Plain description", imageUrl: null, siteName: null });
  });

  it("ignores non-http images and commented-out tags", () => {
    const result = parsePreviewHtml(`<!-- <meta property="og:title" content="Hidden"> --><meta property="og:title" content="Shown"><meta property="og:image" content="javascript:alert(1)"><meta property="twitter:image" content="data:image/png;base64,AAAA">`, "https://e.com");
    expect(result.title).toBe("Shown");
    expect(result.imageUrl).toBeNull();
  });

  it("caps long titles and descriptions", () => {
    const result = parsePreviewHtml(`<meta property="og:title" content="${"t".repeat(500)}"><meta property="og:description" content="${"d".repeat(2000)}">`, "https://e.com");
    expect(result.title!.length).toBe(300);
    expect(result.description!.length).toBe(1000);
  });
});

describe("isBlockedAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "ff02::1", "not-an-ip"])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("fetchLinkPreview", () => {
  it("returns the preview with an absolute image, the final URL and a timestamp, using our User-Agent", async () => {
    const seen: Array<Record<string, string>> = [];
    stub((_url, headers) => { seen.push(headers); return html(PAGE); });
    const result = await fetchLinkPreview("https://example.com/post#frag");
    expect(result).toMatchObject({ url: "https://example.com/post", title: "Hello & welcome", imageUrl: "https://example.com/img/card.png", description: null });
    expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false);
    expect(seen[0]!["user-agent"]).toBe("SocialFlowLinkPreview/1.0");
  });

  it("caches a successful result for repeat requests", async () => {
    const { request } = stub(() => html(PAGE));
    await fetchLinkPreview("https://example.com/a");
    await fetchLinkPreview("https://example.com/a");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("follows redirects and reports the final URL", async () => {
    stub((url) => (url.pathname === "/short" ? response(301, { location: "https://www.example.com/long" }) : html(PAGE)));
    expect((await fetchLinkPreview("https://example.com/short")).url).toBe("https://www.example.com/long");
  });

  it("says so honestly when the page has nothing to show (no_preview)", async () => {
    stub(() => html("<html><body>hi</body></html>"));
    await expect(fetchLinkPreview("https://example.com/")).rejects.toMatchObject({ code: "no_preview" });
  });

  it("refuses non-HTML content", async () => {
    stub(() => response(200, { "content-type": "application/pdf" }, "%PDF"));
    await expect(fetchLinkPreview("https://example.com/a.pdf")).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("reports an upstream error status as fetch_failed", async () => {
    stub(() => response(404, { "content-type": "text/html" }, "nope"));
    await expect(fetchLinkPreview("https://example.com/missing")).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("stops reading at 1.5 MB and still parses the head", async () => {
    const hop = response(200, { "content-type": "text/html" }, [Buffer.from("<title>Big page</title>"), Buffer.alloc(3 * 1024 * 1024, "a")]);
    stub(() => hop);
    const result = await fetchLinkPreview("https://example.com/big");
    expect(result.title).toBe("Big page");
    expect(hop.destroy).toHaveBeenCalled();
  });

  it("times out", async () => {
    stub(() => new Promise<HopResponse>(() => {}));
    const started = Date.now();
    await expect(safeGet("https://example.com/", { accept: "*/*", maxBytes: 10, allowType: () => true, wrongTypeMessage: "", onOverflow: "fail", timeoutMs: 50 })).rejects.toMatchObject({ code: "fetch_failed", message: expect.stringContaining("too long") });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("SSRF protection", () => {
  const refused = async (url: string) => {
    const { request } = stub(() => html(PAGE));
    await expect(fetchLinkPreview(url)).rejects.toMatchObject({ code: "invalid_url" });
    expect(request).not.toHaveBeenCalled();
  };

  it.each([
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://10.0.0.5/admin",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://localhost/",
    "http://app.localhost/",
    "http://printer.local/",
  ])("refuses %s without connecting", async (url) => refused(url));

  it.each(["http://example.com:8080/", "https://example.com:22/", "http://example.com:6379/"])("refuses non-standard port %s", async (url) => refused(url));
  it.each(["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "gopher://example.com/", "not a url", "", "https://user:pw@example.com/"])("refuses %s", async (url) => refused(url));

  it("allows explicit ports 80 and 443", async () => {
    stub(() => html(PAGE));
    await expect(fetchLinkPreview("http://example.com:80/")).resolves.toBeTruthy();
    await expect(fetchLinkPreview("https://example.com:443/")).resolves.toBeTruthy();
  });

  it("refuses a hostname that resolves to a private address, even if another address is public", async () => {
    const { request } = stub(() => html(PAGE), { "evil.test": ["93.184.216.34", "10.0.0.7"], "meta.test": ["169.254.169.254"] });
    await expect(fetchLinkPreview("https://evil.test/")).rejects.toMatchObject({ code: "invalid_url" });
    await expect(fetchLinkPreview("https://meta.test/")).rejects.toMatchObject({ code: "invalid_url" });
    expect(request).not.toHaveBeenCalled();
  });

  it("connects to the address it validated", async () => {
    const { request } = stub(() => html(PAGE), { "good.test": ["93.184.216.34"] });
    await fetchLinkPreview("https://good.test/");
    expect(request.mock.calls[0]![1]).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("refuses a redirect to a private address", async () => {
    const { request } = stub((url) => (url.hostname === "example.com" ? response(302, { location: "http://169.254.169.254/latest/meta-data/" }) : html(PAGE)));
    await expect(fetchLinkPreview("https://example.com/")).rejects.toBeInstanceOf(LinkPreviewError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("re-resolves every hop: a redirect to a name that resolves privately is refused", async () => {
    const { request } = stub((url) => (url.hostname === "example.com" ? response(302, { location: "https://rebind.test/x" }) : html(PAGE)), { "rebind.test": ["127.0.0.1"] });
    await expect(fetchLinkPreview("https://example.com/")).rejects.toBeInstanceOf(LinkPreviewError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a non-http scheme or a bad port", async () => {
    stub(() => response(302, { location: "file:///etc/passwd" }));
    await expect(fetchLinkPreview("https://example.com/a")).rejects.toMatchObject({ code: "fetch_failed" });
    stub(() => response(302, { location: "http://example.com:8080/" }));
    await expect(fetchLinkPreview("https://example.com/b")).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("gives up after 4 redirects", async () => {
    const { request } = stub(() => response(302, { location: "https://example.com/next" }));
    await expect(fetchLinkPreview("https://example.com/loop")).rejects.toMatchObject({ code: "fetch_failed", message: expect.stringContaining("too many") });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("reports an unresolvable host as fetch_failed", async () => {
    stub(() => html(PAGE));
    linkPreviewDeps.lookup = async () => { throw new Error("ENOTFOUND"); };
    await expect(fetchLinkPreview("https://nope.test/")).rejects.toMatchObject({ code: "fetch_failed" });
  });
});

describe("fetchPublicImage", () => {
  it("returns image bytes and type", async () => {
    stub(() => response(200, { "content-type": "image/png" }, Buffer.from([1, 2, 3])));
    expect(await fetchPublicImage("https://cdn.example.com/a.png")).toEqual({ bytes: Buffer.from([1, 2, 3]), mimeType: "image/png" });
  });

  it("refuses non-images, oversized images and private hosts", async () => {
    stub(() => html("<html>"));
    await expect(fetchPublicImage("https://cdn.example.com/a")).rejects.toBeInstanceOf(LinkPreviewError);
    stub(() => response(200, { "content-type": "image/jpeg" }, Buffer.alloc(2000)));
    await expect(fetchPublicImage("https://cdn.example.com/a.jpg", 1000)).rejects.toBeInstanceOf(LinkPreviewError);
    const { request } = stub(() => response(200, { "content-type": "image/jpeg" }, "x"));
    await expect(fetchPublicImage("http://10.0.0.1/a.jpg")).rejects.toBeInstanceOf(LinkPreviewError);
    expect(request).not.toHaveBeenCalled();
  });
});

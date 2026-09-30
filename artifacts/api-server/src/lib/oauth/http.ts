const TIMEOUT_MS = 15_000;

export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Provider returned HTTP ${status}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * Calls a provider API and parses JSON. Throws ProviderHttpError on non-2xx so
 * adapters can map provider-specific error bodies. Never logs URLs, since
 * some providers (Meta) take tokens as query parameters.
 *
 * `preprocessRawText`, if given, runs on the raw response body before
 * JSON.parse. Use it to quote bare-numeric ID fields that can exceed
 * Number.MAX_SAFE_INTEGER (JSON.parse silently rounds those to the nearest
 * representable double, corrupting the ID) — see providers/instagram.ts.
 */
export async function requestJson(
  url: string | URL,
  init: RequestInit = {},
  options?: { preprocessRawText?: (text: string) => string; timeoutMs?: number },
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(options?.timeoutMs ?? TIMEOUT_MS),
  });
  let text = await response.text();
  if (text && options?.preprocessRawText) text = options.preprocessRawText(text);
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  if (!response.ok) throw new ProviderHttpError(response.status, body);
  return body;
}

export function field<T = unknown>(value: unknown, key: string): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key] as T | undefined;
}

export function stringField(value: unknown, key: string): string | null {
  const candidate = field(value, key);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export function numberField(value: unknown, key: string): number | null {
  const candidate = field(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

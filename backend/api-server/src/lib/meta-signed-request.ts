import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Meta signs the requests it sends to an app's callbacks (deauthorize, data deletion) as
 *   signed_request = base64url(HMAC-SHA256(payload, app secret)) + "." + base64url(payload JSON)
 * where the HMAC is computed over the base64url payload string. Anything that doesn't verify against one of our
 * app secrets is refused, so nobody can trigger a deletion by posting a made-up user id.
 */

export type SignedRequestPayload = { user_id?: string; algorithm?: string; issued_at?: number };

const fromBase64Url = (value: string): Buffer => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The decoded payload if the signature matches `secret`, otherwise null. */
export function verifySignedRequest(signedRequest: unknown, secret: string): SignedRequestPayload | null {
  if (typeof signedRequest !== "string" || !secret || signedRequest.length > 4096) return null;
  const parts = signedRequest.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [signature, payload] = parts as [string, string];
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = fromBase64Url(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(fromBase64Url(payload).toString("utf8")) as SignedRequestPayload;
    if (!data || typeof data !== "object") return null;
    if (data.algorithm && String(data.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    return data;
  } catch {
    return null;
  }
}

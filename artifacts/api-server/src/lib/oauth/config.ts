import type { Platform } from "./types";

/**
 * Base URL used to build OAuth redirect (callback) URLs. Redirect URLs are
 * never derived from the request's Host header.
 *
 * - OAUTH_REDIRECT_BASE_URL wins when set (use this for production/custom
 *   domains, e.g. https://app.example.com).
 * - Otherwise in development: https://$REPLIT_DEV_DOMAIN
 * - Otherwise in production: https://<first entry of $REPLIT_DOMAINS>
 */
export function getRedirectBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.OAUTH_REDIRECT_BASE_URL?.trim();
  const fallbackDomain =
    env.NODE_ENV === "production"
      ? env.REPLIT_DOMAINS?.split(",")[0]?.trim()
      : (env.REPLIT_DEV_DOMAIN?.trim() ?? env.REPLIT_DOMAINS?.split(",")[0]?.trim());
  const raw = explicit || (fallbackDomain ? `https://${fallbackDomain}` : "");
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) return null;
  return url.origin;
}

export function getCallbackUrl(
  platform: Platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const base = getRedirectBaseUrl(env);
  return base ? `${base}/api/connections/${platform}/callback` : null;
}

/**
 * First-comment permissions (Facebook pages_manage_engagement, Instagram instagram_business_manage_comments,
 * YouTube youtube.force-ssl) are only added to sign-in requests when COMMENT_SCOPES_ENABLED=true. Networks reject
 * sign-in requests for a permission the developer app hasn't been given, so it is off until the app has them.
 * Accounts connected without them still publish; first comments then explain that the account needs reconnecting.
 */
export function commentScopesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true)$/i.test(env.COMMENT_SCOPES_ENABLED?.trim() ?? "");
}

/**
 * Reach and impressions need extra permissions (Facebook read_insights, Instagram instagram_business_manage_insights).
 * They are only requested when ANALYTICS_SCOPES_ENABLED=true, for the same reason as the comment scopes: a sign-in that
 * asks for a permission the developer app doesn't have is rejected by the network.
 */
export function analyticsScopesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true)$/i.test(env.ANALYTICS_SCOPES_ENABLED?.trim() ?? "");
}

/** Where the browser is sent after the OAuth flow finishes (relative path). */
export const WORKSPACE_PATH = "/workspace";

/** Where an unauthenticated browser is sent before starting OAuth. */
export const SIGNIN_PATH = "/signin";

export const STATE_TTL_MS = 10 * 60 * 1000;
export const PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * Direct messages and mentions need extra permissions (Facebook pages_messaging + pages_manage_metadata, Instagram
 * instagram_business_manage_messages) that Meta only grants after app review. They are only requested, and DMs and
 * mentions only collected, when MESSAGING_SCOPES_ENABLED=true. Off, sign-in requests and the inbox behave as before.
 */
export function messagingScopesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true)$/i.test(env.MESSAGING_SCOPES_ENABLED?.trim() ?? "");
}

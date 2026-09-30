export type OAuthErrorCode =
  | "not_configured"
  | "access_denied"
  | "invalid_state"
  | "invalid_callback"
  | "token_exchange_failed"
  | "missing_scopes"
  | "no_accounts"
  | "account_not_granted"
  | "token_expired"
  | "token_revoked"
  | "insufficient_permissions"
  | "rate_limited"
  | "publish_failed"
  | "publish_unsupported"
  | "provider_error";

const messages: Record<OAuthErrorCode, string> = {
  not_configured:
    "This platform isn't configured on the server yet. Add its credentials to Replit Secrets.",
  access_denied: "Authorization was cancelled or denied.",
  invalid_state:
    "The connection request expired or didn't come from this browser. Please try again.",
  invalid_callback: "The provider returned an invalid response. Please try again.",
  token_exchange_failed:
    "The provider rejected the authorization code. Check the app credentials and redirect URL.",
  missing_scopes:
    "Some required permissions were not granted. Reconnect and allow all requested permissions.",
  no_accounts: "No eligible accounts were found for this login.",
  account_not_granted:
    "The account you're reconnecting wasn't included in the permissions you granted.",
  token_expired: "The access token has expired. Reconnect the account.",
  token_revoked: "Access was revoked on the provider's side. Reconnect the account.",
  insufficient_permissions:
    "The app doesn't have permission for this action. Reconnect and grant the requested permissions.",
  rate_limited: "The provider is rate limiting requests. Try again in a few minutes.",
  publish_failed: "The network rejected this post.",
  publish_unsupported: "This network can't publish this kind of post yet.",
  provider_error: "The provider returned an unexpected error. Please try again.",
};

export class OAuthError extends Error {
  constructor(
    public readonly code: OAuthErrorCode,
    message?: string,
    public readonly details: { missingScopes?: string[]; providerMessage?: string } = {},
  ) {
    super(message ?? messages[code]);
    this.name = "OAuthError";
  }
}

export function oauthErrorMessage(code: OAuthErrorCode): string {
  return messages[code];
}

export function isOAuthErrorCode(value: string): value is OAuthErrorCode {
  return value in messages;
}

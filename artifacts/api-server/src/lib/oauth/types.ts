import type { ConnectionStatus } from "@workspace/db";

export const platforms = ["facebook", "instagram", "linkedin", "youtube"] as const;
export type Platform = (typeof platforms)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (platforms as readonly string[]).includes(value);
}

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/** A Page / organization / channel the user can choose to connect. */
export interface AccountCandidate {
  externalAccountId: string;
  accountType: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
  metadata: Record<string, unknown>;
  /** False when the account cannot be used for publishing (e.g. missing Page role). */
  selectable: boolean;
  warnings: string[];
}

export interface AuthorizationResult {
  externalUserId: string;
  grantedScopes: string[];
  candidates: AccountCandidate[];
}

export interface StoredAccountCredentials {
  externalAccountId: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
}

export interface VerificationResult {
  status: ConnectionStatus;
  detail: string | null;
  scopes?: string[];
  tokenExpiresAt?: Date | null;
  displayName?: string;
  avatarUrl?: string | null;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

export interface BuildAuthorizationUrlInput {
  state: string;
  redirectUri: string;
  /** PKCE S256 challenge, only passed when `usesPkce` is true. */
  codeChallenge?: string;
  /** True when re-authorizing an existing account (re-request declined scopes). */
  reconnect: boolean;
}

export interface HandleCallbackInput {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

/**
 * A platform adapter. Everything provider-specific lives behind this
 * interface; routes, storage, state handling and encryption are shared.
 */
export interface OAuthProviderAdapter {
  platform: Platform;
  displayName: string;
  /** Environment variables (Replit Secrets) this adapter needs. */
  requiredEnv: string[];
  requiredScopes: string[];
  optionalScopes: string[];
  usesPkce: boolean;
  buildAuthorizationUrl(input: BuildAuthorizationUrlInput): string;
  handleCallback(input: HandleCallbackInput): Promise<AuthorizationResult>;
  verifyAccount(account: StoredAccountCredentials): Promise<VerificationResult>;
  /** Present for providers that issue refresh tokens (Google, LinkedIn). */
  refreshAccessToken?(refreshToken: string): Promise<RefreshedTokens>;
}

export interface ProviderDefinition {
  platform: Platform;
  displayName: string;
  requiredEnv: string[];
  requiredScopes: string[];
  optionalScopes: string[];
  /** False for platforms whose adapter hasn't been built yet. */
  implemented: boolean;
  create(credentials: ProviderCredentials): OAuthProviderAdapter;
}

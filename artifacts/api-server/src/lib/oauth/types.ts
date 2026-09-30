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
  /** Permissions the account was connected with. */
  scopes?: string[];
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  /** e.g. "facebook_page", "linkedin_organization". Optional so existing
   * call sites and tests that only need the token still type-check. */
  accountType?: string;
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

/** A stored file to publish with a post. Adapters that upload bytes read `filePath`; ones the network pulls from a URL use `publicUrl`. */
export interface PublishMedia {
  kind: "image" | "video";
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  filePath: string;
  /** A time-limited public https link, or null when the app has no public address. */
  publicUrl: string | null;
}

/** What to publish: the text and the post's media in the order the user arranged it. */
/** A link attached to the post as a preview card (a snapshot of what the composer showed). */
export interface PublishLink {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
}

export interface PublishInput {
  text: string;
  media?: PublishMedia[];
  /**
   * Only acted on when the post has no media. Facebook and LinkedIn turn it into a clickable link card; Instagram
   * (which has no such card and can't publish text alone) uses its imageUrl as the post's photo instead. YouTube
   * ignores it.
   */
  link?: PublishLink | null;
}

/** Numbers for one post. undefined/null = the network didn't report it (never a made-up zero). */
export interface PostMetricValues {
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  views?: number | null;
  impressions?: number | null;
  reach?: number | null;
  saves?: number | null;
}

export interface MetricsResult {
  account: { followers?: number | null; mediaCount?: number | null; viewsTotal?: number | null };
  /** By the network's own post ID. */
  posts: Record<string, PostMetricValues>;
  /** Reasons something is missing, shown to the user as-is. */
  notes: Array<{ code: string; message: string }>;
}

export interface PublishCommentInput {
  /** The network's ID for the post the comment goes under (from PublishResult). */
  externalPostId: string;
  text: string;
}

export interface PublishCommentResult {
  externalCommentId: string;
}

export interface PublishResult {
  /** The network's identifier for the created post. */
  externalPostId: string;
  /** Something that didn't go as planned but didn't stop the post (shown on the published post). */
  notice?: string;
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
  /** Present for networks that can publish a post (text, with images or video where the network supports it). Throws OAuthError on failure. */
  publishPost?(account: StoredAccountCredentials, input: PublishInput): Promise<PublishResult>;
  /** Present for networks whose API reports follower and post numbers. Throws OAuthError only for token-level failures. */
  collectMetrics?(account: StoredAccountCredentials, input: { postIds: string[] }): Promise<MetricsResult>;
  /** Present for networks where the app can post a comment under its own post ("first comment"). */
  publishComment?(account: StoredAccountCredentials, input: PublishCommentInput): Promise<PublishCommentResult>;
  /** The permission publishComment needs; accounts connected without it are told to reconnect. */
  commentScope?: string;
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

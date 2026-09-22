import { isEncryptionConfigured } from "../crypto";
import { getCallbackUrl } from "./config";
import { OAuthError } from "./errors";
import { facebookProvider } from "./providers/facebook";
import type { OAuthProviderAdapter, Platform, ProviderDefinition } from "./types";

// Platforms not yet implemented are registered so the UI and setup checks can
// report them honestly. Implementing one means writing a `create` adapter in
// ./providers and flipping `implemented` to true.
function notImplemented(platform: Platform): never {
  throw new OAuthError("not_configured", `${platform} connections are not implemented yet.`);
}

const placeholders: ProviderDefinition[] = [
  {
    platform: "instagram",
    displayName: "Instagram Business",
    requiredEnv: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"],
    requiredScopes: ["instagram_business_basic", "instagram_business_content_publish"],
    optionalScopes: [],
    implemented: false,
    create: () => notImplemented("instagram"),
  },
  {
    platform: "linkedin",
    displayName: "LinkedIn",
    requiredEnv: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    requiredScopes: ["openid", "profile", "w_member_social"],
    optionalScopes: ["r_organization_social", "w_organization_social", "rw_organization_admin"],
    implemented: false,
    create: () => notImplemented("linkedin"),
  },
  {
    platform: "youtube",
    displayName: "YouTube",
    requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    requiredScopes: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.upload",
    ],
    optionalScopes: [],
    implemented: false,
    create: () => notImplemented("youtube"),
  },
];

const definitions: Record<Platform, ProviderDefinition> = Object.fromEntries(
  [facebookProvider, ...placeholders].map((d) => [d.platform, d]),
) as Record<Platform, ProviderDefinition>;

export function getProviderDefinition(platform: Platform): ProviderDefinition {
  return definitions[platform];
}

export function listProviderDefinitions(): ProviderDefinition[] {
  return Object.values(definitions);
}

/** Lists everything that prevents a platform from working, by name only. */
export function missingConfiguration(platform: Platform): string[] {
  const definition = definitions[platform];
  const missing = definition.requiredEnv.filter((name) => !process.env[name]?.trim());
  if (!isEncryptionConfigured()) missing.push("TOKEN_ENCRYPTION_KEY");
  if (!getCallbackUrl(platform)) missing.push("OAUTH_REDIRECT_BASE_URL");
  return missing;
}

/**
 * Returns a ready adapter, or throws `not_configured` if the platform isn't
 * implemented or any credential is missing. Never falls back to mock data.
 */
export function getAdapter(platform: Platform): OAuthProviderAdapter {
  const definition = definitions[platform];
  if (!definition.implemented) notImplemented(platform);
  const missing = missingConfiguration(platform);
  if (missing.length > 0) {
    throw new OAuthError(
      "not_configured",
      `${definition.displayName} is missing configuration: ${missing.join(", ")}`,
    );
  }
  const [idVar, secretVar] = definition.requiredEnv;
  return definition.create({
    clientId: process.env[idVar!]!.trim(),
    clientSecret: process.env[secretVar!]!.trim(),
  });
}

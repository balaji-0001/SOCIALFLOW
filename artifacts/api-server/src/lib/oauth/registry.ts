import { isEncryptionConfigured } from "../crypto";
import { getCallbackUrl } from "./config";
import { OAuthError } from "./errors";
import { facebookProvider } from "./providers/facebook";
import { instagramProvider } from "./providers/instagram";
import { linkedinProvider } from "./providers/linkedin";
import { youtubeProvider } from "./providers/youtube";
import type { OAuthProviderAdapter, Platform, ProviderDefinition } from "./types";

// A platform not yet implemented would be registered here as a placeholder
// with `implemented: false`, so the UI and setup checks can report it
// honestly instead of mocking it. All four platforms currently ship an
// adapter; this stays exported for the next platform that doesn't.
function notImplemented(platform: Platform): never {
  throw new OAuthError("not_configured", `${platform} connections are not implemented yet.`);
}

const definitions: Record<Platform, ProviderDefinition> = Object.fromEntries(
  [facebookProvider, instagramProvider, linkedinProvider, youtubeProvider].map((d) => [d.platform, d]),
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

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// AES-256-GCM encryption for OAuth tokens at rest.
//
// Format: v1.<iv>.<authTag>.<ciphertext> (base64url segments). The additional
// authenticated data (AAD) binds a ciphertext to its context (e.g. the
// connected account it belongs to) so an encrypted token cannot be copied onto
// another row and still decrypt.
//
// TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 or hex encoded.
// TOKEN_ENCRYPTION_KEY_PREVIOUS is tried for decryption only, so the key can
// be rotated: set the new key, move the old one to _PREVIOUS, and re-encrypt.

const VERSION = "v1";
const IV_BYTES = 12;

export class EncryptionConfigError extends Error {}

function parseKey(raw: string, name: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 16) {
    throw new EncryptionConfigError(
      `${name} must be at least 16 characters or 32 bytes base64/hex.`,
    );
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length === 32) {
    return key;
  }
  return createHash("sha256").update(trimmed).digest();
}

function currentKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new EncryptionConfigError("TOKEN_ENCRYPTION_KEY is not set.");
  }
  return parseKey(raw, "TOKEN_ENCRYPTION_KEY");
}

function decryptionKeys(): Buffer[] {
  const keys = [currentKey()];
  const previous = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  if (previous) keys.push(parseKey(previous, "TOKEN_ENCRYPTION_KEY_PREVIOUS"));
  return keys;
}

export function isEncryptionConfigured(): boolean {
  try {
    currentKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", currentKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, aad: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("Unsupported encrypted payload format.");
  }
  for (const key of decryptionKeys()) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Try the next key.
    }
  }
  throw new Error("Unable to decrypt payload.");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

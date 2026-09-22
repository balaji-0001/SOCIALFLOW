import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "./crypto";

describe("token encryption", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips with matching AAD and never contains the plaintext", () => {
    const encrypted = encryptSecret("EAA-secret-token", "account:1");
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("EAA-secret-token");
    expect(decryptSecret(encrypted, "account:1")).toBe("EAA-secret-token");
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret("same", "a")).not.toBe(encryptSecret("same", "a"));
  });

  it("rejects a ciphertext moved to a different context (AAD mismatch)", () => {
    const encrypted = encryptSecret("token", "account:1");
    expect(() => decryptSecret(encrypted, "account:2")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const [v, iv, tag, ct] = encryptSecret("token", "a").split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."), "a")).toThrow();
  });

  it("decrypts with the previous key after rotation", () => {
    const oldKey = process.env.TOKEN_ENCRYPTION_KEY!;
    const encrypted = encryptSecret("token", "a");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "f".repeat(64));
    expect(() => decryptSecret(encrypted, "a")).toThrow();
    vi.stubEnv("TOKEN_ENCRYPTION_KEY_PREVIOUS", oldKey);
    expect(decryptSecret(encrypted, "a")).toBe("token");
  });

  it("reports misconfigured keys", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "too-short");
    expect(isEncryptionConfigured()).toBe(false);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
    expect(isEncryptionConfigured()).toBe(false);
  });
});

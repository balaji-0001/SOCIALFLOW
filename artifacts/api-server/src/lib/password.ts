import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Password hashing with scrypt (Node's built-in KDF; no extra dependency).
// Format: scrypt$N$r$p$<salt-b64url>$<hash-b64url>. Encoding the cost
// parameters lets them be tuned later without breaking existing hashes.

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SALT_BYTES = 16;
const KEY_LENGTH = 64;
// N=16384 (2^14) is Node's documented baseline for interactive logins.
// Memory cost is roughly 128*N*r bytes (~16MB here), under the 32MB default.
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, DEFAULT_PARAMS);
  return [
    "scrypt",
    DEFAULT_PARAMS.N,
    DEFAULT_PARAMS.r,
    DEFAULT_PARAMS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64!, "base64url");
    expected = Buffer.from(hashB64!, "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password.normalize("NFKC"), salt, expected.length, { N, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function isPasswordStrongEnough(password: unknown): password is string {
  return typeof password === "string" && password.length >= 8 && password.length <= 256;
}

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  // Deliberately permissive: real validation happens by sending mail, which
  // this project doesn't do yet. Just reject obviously-not-an-email input.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 320 ? trimmed : null;
}

/**
 * RFC 6238 TOTP (Time-Based One-Time Password) implementation.
 *
 * Zero external dependencies — uses `node:crypto` for HMAC-SHA1 and
 * implements RFC 4648 base32 encoding/decoding inline.
 *
 * Used by the HQ 2FA system to generate and verify authenticator codes.
 * The TOTP secret is stored vault-encrypted in `auth.json`; this module
 * deals only with the cryptographic primitives, not persistence.
 *
 * @module security/totp
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ── RFC 4648 Base32 ─────────────────────────────────────────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * RFC 4648 base32 encode (no padding). Used to encode TOTP secrets for
 * authenticator apps (Google Authenticator, Authy, 1Password, etc.).
 */
export function base32Encode(buffer: Buffer): string {
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

/**
 * RFC 4648 base32 decode. Tolerates whitespace and lowercase input
 * (authenticator apps sometimes normalize). Throws on truly invalid chars.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── TOTP core ───────────────────────────────────────────────────────────────

const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_WINDOW = 1; // ±1 step (30s before + 30s after)

/**
 * Generate a random TOTP secret (20 bytes of entropy → 32 base32 chars).
 * This is the recommended secret length per RFC 6238 §5.1.
 */
export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

/**
 * HOTP (RFC 4226) core: compute a single OTP from a counter value.
 */
export function hotp(secret: Buffer, counter: number, digits = DEFAULT_DIGITS): string {
  // Counter as 8-byte big-endian buffer
  const counterBuffer = Buffer.alloc(8);
  // Use writeUInt32BE for high and low 32 bits (counters are < 2^53 in practice)
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(counterBuffer).digest();
  // Dynamic truncation (RFC 4226 §5.3)
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Compute the TOTP counter for a given timestamp.
 * T = floor(unixSeconds / stepSeconds)
 */
export function totpCounter(unixSeconds: number, stepSeconds = DEFAULT_STEP_SECONDS): number {
  return Math.floor(unixSeconds / stepSeconds);
}

/**
 * Generate a TOTP code for the current time.
 *
 * @param secretBase32 - base32-encoded secret (from `generateTotpSecret`)
 * @param atMs - epoch milliseconds; defaults to `Date.now()`. Exposed for tests.
 * @param stepSeconds - time step in seconds; defaults to 30 (RFC 6238 default).
 * @param digits - number of digits in the code; defaults to 6.
 */
export function generateTotp(
  secretBase32: string,
  atMs: number = Date.now(),
  stepSeconds: number = DEFAULT_STEP_SECONDS,
  digits: number = DEFAULT_DIGITS,
): string {
  const secret = base32Decode(secretBase32);
  const counter = totpCounter(Math.floor(atMs / 1000), stepSeconds);
  return hotp(secret, counter, digits);
}

/**
 * Verify a TOTP code with a ±window tolerance. Uses constant-time string
 * comparison on each attempt.
 *
 * @param code - the code entered by the user
 * @param secretBase32 - base32-encoded secret
 * @param atMs - epoch milliseconds; defaults to `Date.now()`
 * @param window - number of steps before/after the current step to accept.
 *   0 = exact step only; 1 = ±30s (default); 2 = ±60s.
 * @returns `true` if the code matches any step within the window.
 */
export function verifyTotp(
  code: string,
  secretBase32: string,
  atMs: number = Date.now(),
  window: number = DEFAULT_WINDOW,
  stepSeconds: number = DEFAULT_STEP_SECONDS,
  digits: number = DEFAULT_DIGITS,
): boolean {
  return verifyTotpCounter(code, secretBase32, atMs, window, stepSeconds, digits) !== undefined;
}

/**
 * Like {@link verifyTotp}, but returns the time-step counter the code matched
 * so the caller can enforce single use.
 *
 * RFC 6238 §5.2 requires that a code be accepted only once: the validation
 * window is ±1 step by default, so a code observed in transit stays
 * arithmetically valid for up to ~90 seconds. Recording the matched counter and
 * refusing anything at or below it turns that window into one-shot. HQ's
 * `/api/login/verify` does this against `mutableAuth.totpLastUsedCounter`.
 *
 * @returns the matched counter, or `undefined` when no step in the window
 *   matches.
 */
export function verifyTotpCounter(
  code: string,
  secretBase32: string,
  atMs: number = Date.now(),
  window: number = DEFAULT_WINDOW,
  stepSeconds: number = DEFAULT_STEP_SECONDS,
  digits: number = DEFAULT_DIGITS,
): number | undefined {
  if (typeof code !== 'string' || code.length !== digits) return undefined;
  const secret = base32Decode(secretBase32);
  const currentCounter = totpCounter(Math.floor(atMs / 1000), stepSeconds);

  for (let offset = -window; offset <= window; offset++) {
    const counter = currentCounter + offset;
    const expected = hotp(secret, counter, digits);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
      return counter;
    }
  }
  return undefined;
}

/**
 * Build an `otpauth://` URI for QR-code provisioning (RFC 6238 / Google Auth).
 *
 * Format: `otpauth://totp/<label>?secret=<base32>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30`
 *
 * The URI is used to render a QR code in the settings page. Authenticator
 * apps scan it and store the secret.
 */
export function buildOtpAuthUri(
  secretBase32: string,
  account: string,
  issuer = 'WrongStack HQ',
  stepSeconds = DEFAULT_STEP_SECONDS,
  digits = DEFAULT_DIGITS,
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(stepSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Recovery codes ──────────────────────────────────────────────────────────

const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_BYTES = 8; // 64 bits of entropy per code

/**
 * Generate a batch of single-use recovery codes. Each code is a 16-char
 * hex string with a hyphen separator in the middle for readability.
 *
 * Format: `xxxxxxxx-xxxxxxxx` (8 hex chars, hyphen, 8 hex chars)
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const buf = randomBytes(RECOVERY_CODE_BYTES);
    const hex = buf.toString('hex');
    const formatted = `${hex.slice(0, 8)}-${hex.slice(8)}`;
    // Deduplicate (astronomically unlikely, but defensive)
    if (!seen.has(formatted)) {
      seen.add(formatted);
      codes.push(formatted);
    }
  }
  return codes;
}

/**
 * Hash a recovery code with SHA-256 for storage. Recovery codes are
 * single-use; storing only the hash means a leaked `auth.json` cannot
 * reveal unused codes.
 */
export function hashRecoveryCode(code: string): string {
  // Normalize: strip whitespace and hyphens before hashing so the stored
  // form is independent of how the user typed or pasted the code.
  const normalized = code.replace(/[\s-]/g, '').toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of a recovery code against a list of stored
 * SHA-256 hashes. Returns `true` on match. Callers MUST remove the matched
 * hash from the store after a successful verification (single-use).
 */
export function verifyRecoveryCode(code: string, storedHashes: string[]): boolean {
  const candidate = hashRecoveryCode(code);
  for (const stored of storedHashes) {
    const a = Buffer.from(stored, 'hex');
    const b = Buffer.from(candidate, 'hex');
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

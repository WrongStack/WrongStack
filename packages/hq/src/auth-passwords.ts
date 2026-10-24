import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const HQ_PASSWORD_SALT_BYTES = 16;
const HQ_PASSWORD_HASH_BYTES = 32;

/**
 * scrypt cost for NEW password hashes.
 *
 * Was `N: 16384` (2^14) — below OWASP's floor and, more tellingly, below this
 * repo's own `secret-vault.ts`, which uses 2^15 for a local key file while HQ
 * used less for a credential that can be reached over the network (HQ ships
 * `BIND_IP=0.0.0.0`).
 *
 * Raising it was blocked by something more basic than the number: the stored
 * format was `scrypt$<salt>$<hash>` with **no parameters in it**, so
 * verification always re-derived with whatever the constant happened to be.
 * Changing the constant would have silently invalidated every existing
 * password — a lockout, not a migration. The format below fixes that first;
 * the value is now a one-line change.
 *
 * 2^16 with r=8 needs 128 * N * r = 64 MiB per derivation. 2^17 (OWASP's
 * headline figure) needs 128 MiB per login ATTEMPT on a service that may be
 * internet-reachable, which is a denial-of-service trade rather than a free
 * win; it is left as an owner decision now that the format supports it.
 */
const HQ_PASSWORD_SCRYPT_PARAMS = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

/** Cost used by the legacy, parameter-less `scrypt$<salt>$<hash>` payloads. */
const HQ_PASSWORD_SCRYPT_PARAMS_LEGACY = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Largest scrypt working set a STORED parameter segment may ask for.
 * `auth.json` is a local file, but it is also the only input to a
 * network-reachable login path — a hand-edited or restored-from-elsewhere file
 * must not be able to turn each attempt into a multi-gigabyte allocation.
 */
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

/** `N=65536,r=8,p=1` — the parameter segment of a versioned payload. */
function encodeScryptParams(params: ScryptParams): string {
  return `N=${params.N},r=${params.r},p=${params.p}`;
}

/**
 * Parse a parameter segment, or `null` when it is not one.
 *
 * Values are bounded on the way in: a stored file is not a trusted source of
 * a memory-allocation size. Without the ceiling, an `auth.json` edited to say
 * `N=1073741824` would make every login attempt try to allocate a terabyte.
 */
function parseScryptParams(segment: string): ScryptParams | null {
  const out: Record<string, number> = {};
  for (const part of segment.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const value = Number(part.slice(eq + 1));
    if (!Number.isInteger(value) || value <= 0) return null;
    out[key] = value;
  }
  const { N, r, p } = out;
  if (N === undefined || r === undefined || p === undefined) return null;
  // N must be a power of two (scrypt requires it) and within sane bounds.
  if ((N & (N - 1)) !== 0 || N > 1 << 20) return null;
  if (r > 32 || p > 16) return null;
  // The per-parameter ceilings above bound each factor but not their PRODUCT:
  // `N=1048576,r=32,p=16` satisfies all three and asks for 68 GiB per login
  // attempt on a service that ships `BIND_IP=0.0.0.0`. Bound the derived cost
  // itself, which is the number that actually gets allocated. 256 MiB leaves
  // room for OWASP's 2^17 (128 MiB) while refusing anything that turns a login
  // into a memory-exhaustion primitive.
  const needed = 128 * N * r * p;
  if (needed > MAX_SCRYPT_MEMORY_BYTES) return null;
  return { N, r, p, maxmem: Math.max(needed * 2, 64 * 1024 * 1024) };
}

/**
 * Hash a browser password for storage in `auth.json`. Uses scrypt with a
 * random salt; the returned string is `scrypt$<salt>$<hash>` in base64url.
 */
export function hashHqPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(HQ_PASSWORD_SALT_BYTES);
    scrypt(password, salt, HQ_PASSWORD_HASH_BYTES, HQ_PASSWORD_SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) return reject(err);
      // Four segments now: `scrypt$<params>$<salt>$<hash>`. The cost travels
      // with the hash so a future increase re-derives old passwords with the
      // parameters they were created under instead of failing them.
      const payload = [
        'scrypt',
        encodeScryptParams(HQ_PASSWORD_SCRYPT_PARAMS),
        salt.toString('base64url'),
        derivedKey.toString('base64url'),
      ].join('$');
      resolve(payload);
    });
  });
}

/**
 * True when `hash` was produced with weaker parameters than the current ones.
 *
 * The login route re-hashes on a successful password check, so an existing
 * deployment strengthens itself the next time each user signs in — without a
 * forced reset, and without the operator having to know this happened.
 */
export function hqPasswordNeedsUpgrade(hash: string): boolean {
  const parts = hash.split('$');
  if (parts[0] !== 'scrypt') return false;
  if (parts.length === 3) return true; // legacy, parameter-less
  if (parts.length !== 4 || !parts[1]) return false;
  const params = parseScryptParams(parts[1]);
  if (!params) return false;
  return params.N < HQ_PASSWORD_SCRYPT_PARAMS.N;
}

/**
 * Verify a browser password against a stored scrypt hash.
 */
export async function verifyHqPassword(password: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts[0] !== 'scrypt') return false;

  // Two accepted shapes: the current `scrypt$<params>$<salt>$<hash>` and the
  // legacy `scrypt$<salt>$<hash>`, which carried no parameters and therefore
  // has to be verified at the cost it was written with.
  let params: ScryptParams;
  let saltSegment: string | undefined;
  let hashSegment: string | undefined;
  if (parts.length === 4) {
    const parsed = parts[1] ? parseScryptParams(parts[1]) : null;
    if (!parsed) return false;
    params = parsed;
    saltSegment = parts[2];
    hashSegment = parts[3];
  } else if (parts.length === 3) {
    params = HQ_PASSWORD_SCRYPT_PARAMS_LEGACY;
    saltSegment = parts[1];
    hashSegment = parts[2];
  } else {
    return false;
  }
  if (!saltSegment || !hashSegment) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltSegment, 'base64url');
    expected = Buffer.from(hashSegment, 'base64url');
  } catch {
    return false;
  }
  // `expected.length` becomes scrypt's keylen below, so it is a second
  // allocation size read straight out of the file. A 32-byte digest is what
  // both formats write; anything outside a narrow band is a malformed or
  // hostile payload, not a password this process should spend memory on.
  if (salt.length === 0 || expected.length < 16 || expected.length > 64) return false;
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, expected.length, params, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Mint a secret used to sign browser session cookies. */
export function mintHqCookieSecret(): string {
  return randomBytes(32).toString('base64url');
}

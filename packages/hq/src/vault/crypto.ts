/**
 * HQ key vault cryptography — the primitives both ends share.
 *
 * HQ seals a provider credential to ONE device and signs what it sends; the
 * device proves who it is by signing its requests. None of it relies on the
 * transport: HQ serves plain HTTP today (no TLS in `hq-server.ts`), so a
 * passive listener must learn nothing and an active one must be unable to
 * substitute keys. Everything here is `node:crypto` (X25519, Ed25519, HKDF,
 * AES-256-GCM, HMAC), which Bun and Node both implement.
 *
 * Keys travel as base64url raw 32-byte values — the JWK `x` / `d` members — so
 * a key is one short string in JSON and imports through the JWK path both
 * runtimes support.
 *
 *  - Sealed box: an ephemeral X25519 key agrees a secret with the recipient's
 *    X25519 public key; HKDF-SHA256 turns it into an AES-256-GCM key. The
 *    associated data names the vault, the device, the secret and its version,
 *    so a box cannot be replayed as a different secret or to another device.
 *  - Signatures: Ed25519 over the canonical JSON of the message.
 *  - Enrollment MAC: HMAC-SHA256 keyed by the one-time enrollment code, over
 *    the canonical JSON — it binds the device's public keys (request) and
 *    HQ's public keys (response) to someone who holds the code.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

export const HQ_VAULT_CRYPTO_VERSION = 1;

const SEAL_INFO_PREFIX = 'wstack-hq-vault/v1/seal';
const AES = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const RAW_KEY_BYTES = 32;
const B64URL_KEY = /^[A-Za-z0-9_-]{43}$/;

/** A device's (or HQ's) two key pairs, every member base64url raw. */
export interface HqVaultKeyPair {
  /** X25519 public key — what others seal to. */
  encPublic: string;
  encPrivate: string;
  /** Ed25519 public key — what others verify signatures with. */
  signPublic: string;
  signPrivate: string;
}

export type HqVaultPublicKeys = Pick<HqVaultKeyPair, 'encPublic' | 'signPublic'>;

/** A credential sealed to one recipient. Every member base64url. */
export interface HqSealedBox {
  v: 1;
  /** Ephemeral X25519 public key. */
  epk: string;
  iv: string;
  tag: string;
  ct: string;
}

export class HqVaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HqVaultCryptoError';
  }
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64u(value: string, what: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new HqVaultCryptoError(`${what} is not base64url`);
  }
  return Buffer.from(value, 'base64url');
}

/** True when `value` has the shape of a base64url raw 32-byte key. */
export function isHqVaultKeyString(value: unknown): value is string {
  return typeof value === 'string' && B64URL_KEY.test(value);
}

function assertKeyString(value: unknown, what: string): asserts value is string {
  if (!isHqVaultKeyString(value)) throw new HqVaultCryptoError(`${what} is not a 32-byte key`);
}

function publicKey(crv: 'X25519' | 'Ed25519', x: string): KeyObject {
  assertKeyString(x, `${crv} public key`);
  return createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' });
}

function privateKey(crv: 'X25519' | 'Ed25519', x: string, d: string): KeyObject {
  assertKeyString(x, `${crv} public key`);
  assertKeyString(d, `${crv} private key`);
  return createPrivateKey({ key: { kty: 'OKP', crv, x, d }, format: 'jwk' });
}

function jwkMembers(key: KeyObject): { x: string; d: string } {
  const jwk = key.export({ format: 'jwk' }) as { x?: string; d?: string };
  if (typeof jwk.x !== 'string' || typeof jwk.d !== 'string') {
    throw new HqVaultCryptoError('key export did not produce raw OKP members');
  }
  return { x: jwk.x, d: jwk.d };
}

/** Generate a fresh X25519 + Ed25519 identity. */
export function generateHqVaultKeyPair(): HqVaultKeyPair {
  const enc = jwkMembers(generateKeyPairSync('x25519').privateKey);
  const sig = jwkMembers(generateKeyPairSync('ed25519').privateKey);
  return { encPublic: enc.x, encPrivate: enc.d, signPublic: sig.x, signPrivate: sig.d };
}

/**
 * Stable identifier of a key pair: a hash of BOTH public keys. A device id is
 * therefore not something a caller can choose — it is whatever its keys say,
 * unlike the hostname-derived `stableMachineId`.
 */
export function hqVaultKeyId(keys: HqVaultPublicKeys): string {
  assertKeyString(keys.encPublic, 'encPublic');
  assertKeyString(keys.signPublic, 'signPublic');
  return createHash('sha256')
    .update(`wstack-hq-vault/v1/id\0${keys.encPublic}\0${keys.signPublic}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Human-comparable fingerprint of a key pair: 8 groups of 4 hex digits. Shown
 * on both sides of an enrollment so an operator can compare them.
 */
export function hqVaultFingerprint(keys: HqVaultPublicKeys): string {
  const hex = createHash('sha256')
    .update(`wstack-hq-vault/v1/fp\0${keys.encPublic}\0${keys.signPublic}`)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}

/**
 * Deterministic JSON: object keys sorted at every depth, `undefined` members
 * dropped. What gets signed and MACed — two parties serialising the same value
 * must produce the same bytes.
 */
export function hqVaultCanonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = sortValue(member);
    }
    return out;
  }
  return value;
}

function sealKey(shared: Buffer, aad: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), `${SEAL_INFO_PREFIX}\0${aad}`, 32),
  );
}

/** Seal `plaintext` so only the holder of `recipientEncPublic`'s private key opens it. */
export function hqVaultSeal(
  plaintext: string,
  recipientEncPublic: string,
  aad: string,
): HqSealedBox {
  const recipient = publicKey('X25519', recipientEncPublic);
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = sealKey(shared, aad);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    epk: jwkMembers(ephemeral.privateKey).x,
    iv: b64u(iv),
    tag: b64u(cipher.getAuthTag()),
    ct: b64u(ct),
  };
}

/** Open a box sealed to `recipient`. Throws on any tampering, wrong key or wrong `aad`. */
export function hqVaultOpen(
  box: HqSealedBox,
  recipient: Pick<HqVaultKeyPair, 'encPublic' | 'encPrivate'>,
  aad: string,
): string {
  if (box === null || typeof box !== 'object' || box.v !== 1) {
    throw new HqVaultCryptoError('unsupported sealed box');
  }
  const iv = fromB64u(box.iv, 'iv');
  const tag = fromB64u(box.tag, 'tag');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new HqVaultCryptoError('sealed box has a malformed iv or tag');
  }
  const shared = diffieHellman({
    privateKey: privateKey('X25519', recipient.encPublic, recipient.encPrivate),
    publicKey: publicKey('X25519', box.epk),
  });
  const decipher = createDecipheriv(AES, sealKey(shared, aad), iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(fromB64u(box.ct, 'ct')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new HqVaultCryptoError('sealed box failed authentication');
  }
}

/** Ed25519-sign the canonical JSON of `message`. */
export function hqVaultSign(
  message: unknown,
  signer: Pick<HqVaultKeyPair, 'signPublic' | 'signPrivate'>,
): string {
  const key = privateKey('Ed25519', signer.signPublic, signer.signPrivate);
  return b64u(sign(null, Buffer.from(hqVaultCanonicalJson(message), 'utf8'), key));
}

/** Verify an Ed25519 signature over the canonical JSON of `message`. Never throws. */
export function hqVaultVerify(message: unknown, signature: unknown, signPublic: string): boolean {
  if (typeof signature !== 'string') return false;
  try {
    const sig = fromB64u(signature, 'signature');
    if (sig.length !== 64) return false;
    return verify(
      null,
      Buffer.from(hqVaultCanonicalJson(message), 'utf8'),
      publicKey('Ed25519', signPublic),
      sig,
    );
  } catch {
    return false;
  }
}

/** HMAC-SHA256 of the canonical JSON of `message`, keyed by an enrollment code. */
export function hqVaultEnrollmentMac(code: string, message: unknown): string {
  return b64u(
    createHmac('sha256', fromB64u(code, 'enrollment code'))
      .update(hqVaultCanonicalJson(message), 'utf8')
      .digest(),
  );
}

/** Constant-time check of an enrollment MAC. Never throws. */
export function hqVaultEnrollmentMacMatches(code: string, message: unknown, mac: unknown): boolean {
  if (typeof mac !== 'string') return false;
  try {
    const expected = Buffer.from(hqVaultEnrollmentMac(code, message), 'base64url');
    const given = fromB64u(mac, 'mac');
    return given.length === expected.length && timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

/** A fresh random value, base64url — nonces, codes, ids. */
export function hqVaultRandom(bytes = RAW_KEY_BYTES): string {
  return b64u(randomBytes(bytes));
}

// ── Symmetric envelope (HQ at rest) ─────────────────────────────────────────

/** AES-256-GCM ciphertext with its iv and tag, every member base64url. */
export interface HqVaultCipherText {
  iv: string;
  tag: string;
  ct: string;
}

/** Encrypt under a raw 32-byte key with associated data. */
export function hqVaultEncrypt(key: Buffer, plaintext: Buffer, aad: string): HqVaultCipherText {
  if (key.length !== RAW_KEY_BYTES) throw new HqVaultCryptoError('key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64u(iv), tag: b64u(cipher.getAuthTag()), ct: b64u(ct) };
}

/** Decrypt {@link hqVaultEncrypt} output. Throws on tampering or a wrong key/aad. */
export function hqVaultDecrypt(key: Buffer, box: HqVaultCipherText, aad: string): Buffer {
  if (key.length !== RAW_KEY_BYTES) throw new HqVaultCryptoError('key must be 32 bytes');
  const iv = fromB64u(box.iv, 'iv');
  const tag = fromB64u(box.tag, 'tag');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new HqVaultCryptoError('ciphertext has a malformed iv or tag');
  }
  const decipher = createDecipheriv(AES, key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(fromB64u(box.ct, 'ct')), decipher.final()]);
  } catch {
    throw new HqVaultCryptoError('ciphertext failed authentication');
  }
}

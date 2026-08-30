import { randomBytes } from 'node:crypto';

/**
 * Crockford base32 alphabet (excludes I, L, O, U to avoid ambiguity).
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  let mod: number;
  let str = '';
  for (let i = len - 1; i >= 0; i--) {
    mod = now % ENCODING_LEN;
    str = ENCODING[mod] + str;
    now = (now - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let str = '';
  for (let i = 0; i < len; i++) {
    str += ENCODING[(bytes[i] as number) % ENCODING_LEN];
  }
  return str;
}

/**
 * Generate a ULID — a 26-char Crockford-base32 identifier whose first 10 chars
 * encode the millisecond timestamp (so IDs sort lexicographically by creation
 * time) followed by 16 chars of randomness. Zero runtime dependencies.
 *
 * The codebase convention is "IDs are ULIDs"; use this for any new store key.
 */
export function ulid(seedTime: number = Date.now()): string {
  const safeTime = typeof seedTime === 'number' && Number.isFinite(seedTime) && seedTime > 0 ? seedTime : Date.now();
  return encodeTime(safeTime, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

/** True for a well-formed 26-char Crockford-base32 ULID. */
export function isUlid(value: string): boolean {
  if (typeof value !== 'string' || value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of value) {
    if (!ENCODING.includes(ch)) return false;
  }
  return true;
}

import { describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';

const s = new DefaultSecretScrubber();
const CHUNK = 64 * 1024;
// No recognisable prefix: only the whitespace-bearing patterns can catch it.
const SECRET = 'Zq8Lm2Vx9TrNp4KdWs7Hc3Yb';

/** A text whose payload starts at `start`, preceded by a space, in whitespace-separated filler. */
function withPayloadAt(payload: string, start: number): string {
  const filler = 'ab '.repeat(Math.ceil(start / 3)).slice(0, start - 1);
  return `${filler} ${payload}\n${'cd '.repeat(2000)}`;
}

describe('chunk boundary vs whitespace-bearing credentials', () => {
  // `Bearer <t>`, `KEY = <v>` and a pretty-printed `"key": "<v>"` all contain
  // whitespace, so snapping the 64KB cut to the next whitespace could end the
  // chunk between the key and its value and emit the value verbatim.
  it.each([
    ['pretty-printed json', `{"apiKey": "${SECRET}"}`],
    ['json with padded colon', `{"x-api-key"  :  "${SECRET}"}`],
    ['bearer scheme', `Authorization: Bearer ${SECRET}`],
    ['bearer with a tab', `Authorization: Bearer\t${SECRET}`],
    ['spaced env assignment', `MY_API_KEY = ${SECRET}`],
  ])('redacts %s wherever the cut lands', (_name, payload) => {
    expect(s.scrub(withPayloadAt(payload, 1000))).not.toContain(SECRET); // control
    for (let delta = 0; delta <= payload.length + 2; delta++) {
      const out = s.scrub(withPayloadAt(payload, CHUNK - delta));
      expect(out, `cut ${delta} chars before the payload end`).not.toContain(SECRET);
    }
  });

  it('keeps adjacent spaced secrets whole across the cut', () => {
    const payload = `A_SECRET_TOKEN = ${SECRET} B_SECRET_TOKEN = ${SECRET.toLowerCase()}9`;
    for (let delta = 0; delta <= payload.length; delta++) {
      const out = s.scrub(withPayloadAt(payload, CHUNK - delta));
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(`${SECRET.toLowerCase()}9`);
    }
  });

  it('leaves a clean oversized text untouched', () => {
    const clean = 'plain words with no credentials at all. '.repeat(4000);
    expect(s.scrub(clean)).toBe(clean);
  });
});

describe('high_entropy_env key names', () => {
  const value = 'Qw8Lm2Vx9TrNp4KdWs7Hc3Yb';

  // The key class used to demand 4+ characters before the credential word, so
  // APP_PASSWORD was masked but DB_PASSWORD was not.
  it.each([
    'DB_PASSWORD',
    'GH_TOKEN',
    'MY_SECRET',
    'DB_PWD',
    'X_KEY',
    'PASSWORD',
    'TOKEN',
    'SECRET',
    'APP_PASSWORD',
    'JWT_SECRET',
  ])('redacts %s and keeps the key name', (key) => {
    expect(s.scrub(`${key}=${value}`)).toBe(`${key}=[REDACTED:high_entropy_env]`);
  });

  it.each([
    ['a non-credential name', `DATA_DIR=${value}`],
    ['a name whose credential word is not last', `KEYBOARD=${value}`],
    ['a plural', `TOKENS=${value}`],
    ['a value under 20 characters', 'DB_PASSWORD=short123'],
    ['a lowercase name', `db_password=${value}`],
    ['a name glued to a previous word', `abcDB_PASSWORD=${value}`],
  ])('leaves %s alone', (_label, text) => {
    expect(s.scrub(text)).toBe(text);
  });

  it('redacts adjacent short-name secrets sharing one delimiter', () => {
    const out = s.scrub(`DB_PASSWORD=${value} GH_TOKEN=${value}\nMY_SECRET=${value}`);
    expect(out).toBe(
      'DB_PASSWORD=[REDACTED:high_entropy_env] GH_TOKEN=[REDACTED:high_entropy_env]\nMY_SECRET=[REDACTED:high_entropy_env]',
    );
  });
});

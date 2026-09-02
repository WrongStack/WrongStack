/**
 * @wrongstack/plugins - credential detection parity.
 *
 * `secret-scanner` gates tool input/output; `prompt-firewall` gates the
 * outgoing provider request. They used to carry separate pattern lists
 * which had drifted, so whether a credential was caught depended on which
 * side of the pipeline it crossed. Both now build on
 * `runtime/credential-patterns`; these tests keep them from drifting again.
 */
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_PATTERNS,
  cloneCredentialPatterns,
} from '../src/runtime/credential-patterns.js';
import { detectSecrets } from '../src/prompt-firewall/index.js';

// Helper: construct a postgres URI at test-time to avoid the
// secret-scanner redacting the literal credential pattern in source.
const PG_BASE = ['postgresql', '://', 'localhost', '/app?'].join('');
function pg(qs: string): string {
  return PG_BASE + qs;
}

describe('canonical credential table', () => {
  it('gives every pattern a unique id', () => {
    const types = CREDENTIAL_PATTERNS.map((p) => p.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('makes every pattern global so exec-loops terminate', () => {
    for (const p of CREDENTIAL_PATTERNS) {
      expect(p.regex.flags).toContain('g');
    }
  });

  it('uses no capturing groups in built-in patterns', () => {
    for (const p of CREDENTIAL_PATTERNS) {
      const groupCount = new RegExp(p.regex.source + '|').exec('')!.length - 1;
      expect({ type: p.type, groupCount }).toEqual({ type: p.type, groupCount: 0 });
    }
  });

  it('hands out independently-stateful copies', () => {
    const a = cloneCredentialPatterns();
    const b = cloneCredentialPatterns();
    a[0]!.regex.lastIndex = 42;
    expect(b[0]!.regex.lastIndex).toBe(0);
    expect(a[0]!.regex).not.toBe(b[0]!.regex);
  });
});

describe('prompt-firewall inherits the shared coverage', () => {
  it.each([
    ['gitlab_pat', 'glpat-' + 'A'.repeat(20)],
    ['npm_token', 'npm_' + 'b'.repeat(36)],
    ['sendgrid_key', 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43)],
    ['digitalocean_token', 'dop_v1_' + 'a'.repeat(64)],
    ['stripe_key', 'sk_live_' + 'a'.repeat(24)],
  ])('detects %s in an outgoing request', (kind, sample) => {
    const found = detectSecrets('context: ' + sample, []);
    expect(found.map((d) => d.kind)).toContain(kind);
  });

  it('keeps the legacy kind names its consumers already log', () => {
    const github = detectSecrets('ghp_' + 'a'.repeat(36), []);
    expect(github.map((d) => d.kind)).toContain('github-token');
    const aws = detectSecrets('AKIA' + 'A'.repeat(16), []);
    expect(aws.map((d) => d.kind)).toContain('aws-access-key');
  });

  it('honours the allow list', () => {
    const sample = 'glpat-' + 'A'.repeat(20);
    const found = detectSecrets(sample, [new RegExp(sample)]);
    expect(found.map((d) => d.kind)).not.toContain('gitlab_pat');
  });
});

describe('postgres_uri query-parameter password detection', () => {
  it.each([
    ['password as first param', pg('password=first-secret&user=alice'), true],
    ['password as last param (no other params)', pg('password=secret'), true],
    ['password as last param (with preceding params)', pg('user=alice&password=secret'), true],
    [
      'password in middle (followed by another param)',
      pg('user=alice&password=secret&sslmode=require'),
      true,
    ],
    ['uripassword (no colon)', pg('appname=somepass'), false],
    ['percent-encoded password key', pg('user=alice&pass%77ord=secret'), true],
    ['no password param', pg('user=alice&sslmode=require'), false],
  ])('detects %s', (_label, uri, shouldMatch) => {
    const found = cloneCredentialPatterns().find((p) => p.type === 'postgres_uri');
    expect(found).toBeDefined();
    expect({ uri, matched: found!.regex.test(uri) }).toEqual({
      uri,
      matched: shouldMatch,
    });
  });
});

describe('telegram_bot_token detection', () => {
  const token = '123456:ABCDEFghijklmnopqrstuvwxyz_1234';

  it.each([
    ['raw token', token, true],
    ['url /bot prefix', '/bot' + token, true],
    ['url t.me/bot prefix', 't.me/bot' + token, true],
    ['space-prefixed bot', ' bot' + token, true],
    ['start-of-string bot', 'bot' + token, true],
    ['robot false match', 'robot' + token, false],
    ['abot false match', 'abot' + token, false],
    ['xbot false match', 'xbot' + token, false],
  ])('detects %s', (_label, text, shouldMatch) => {
    const found = cloneCredentialPatterns().find((p) => p.type === 'telegram_bot_token');
    expect(found).toBeDefined();
    found!.regex.lastIndex = 0;
    expect({ text, matched: found!.regex.test(text) }).toEqual({
      text,
      matched: shouldMatch,
    });
  });
});

describe('json_credential_key detection', () => {
  // Attacker goal: a credential with no recognisable prefix rides out of the
  // machine inside a JSON-shaped tool result. Every other pattern in this table
  // keys on SHAPE, so an Azure / self-hosted / OAuth token was invisible to
  // both surfaces until this pattern existed.
  it.each([
    ['plain apiKey', '{"apiKey":"abcdef0123456789abcdef"}', true],
    ['snake_case access_token', '{"access_token":"abcdef0123456789"}', true],
    ['prefixed camelCase key', '{"anthropicApiKey": "abcdef0123456789"}', true],
    ['camelCase accessToken', '{"accessToken":"abcdef0123456789"}', true],
    ['client_secret', '{"client_secret":"abcdef0123456789"}', true],
    // Must NOT fire: these are the false positives that would make the pattern
    // unusable against real tool output.
    ['numeric token counter', '{"tokenCount": 1234}', false],
    ['token budget field', '{"maxTokens": 8000}', false],
    ['short enum value', '{"authorization":"none"}', false],
    ['prose mentioning a token', 'the token was rotated yesterday', false],
    ['package metadata', '{"name":"wrongstack","version":"0.306.3"}', false],
  ])('detects %s', (_label, text, shouldMatch) => {
    const found = cloneCredentialPatterns().find((p) => p.type === 'json_credential_key');
    expect(found).toBeDefined();
    found!.regex.lastIndex = 0;
    expect({ text, matched: found!.regex.test(text) }).toEqual({ text, matched: shouldMatch });
  });

  it('reaches the outgoing provider request through prompt-firewall', () => {
    const found = detectSecrets('{"apiKey":"abcdef0123456789abcdef"}', []);
    expect(found.map((d) => d.kind)).toContain('json_credential_key');
  });
});

describe('aws-secret-key detection', () => {
  const alnumKey = 'wJalrXUtnFEMIKbPxRfiCYEXAMPLEKEY12345678';
  const base64Key = 'wJalrXUtnFEMIKbPxRfiCYEXAMPLEKEY123456' + '/+';

  it.each([
    ['AWS_SECRET_ACCESS_KEY assignment', 'AWS_SECRET_ACCESS_KEY=' + alnumKey],
    ['lowercase yaml key', 'aws_secret_access_key: ' + alnumKey],
    ['quoted value', 'aws_secret_key = "' + alnumKey + '"'],
    ['key ending in base64 padding chars', 'AWS_SECRET_ACCESS_KEY=' + base64Key],
  ])('detects %s', (_label, text) => {
    expect(detectSecrets(text, []).map((d) => d.kind)).toContain('aws-secret-key');
  });

  it('does not fire on an unrelated 40-char token', () => {
    const found = detectSecrets('sha=' + 'a'.repeat(40), []);
    expect(found.map((d) => d.kind)).not.toContain('aws-secret-key');
  });
});

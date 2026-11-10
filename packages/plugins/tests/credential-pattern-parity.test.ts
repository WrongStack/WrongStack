/**
 * @wrongstack/plugins - credential detection parity.
 *
 * `secret-scanner` gates tool input/output; `prompt-firewall` gates the
 * outgoing provider request. They used to carry separate pattern lists
 * which had drifted, so whether a credential was caught depended on which
 * side of the pipeline it crossed. Both now build on
 * `runtime/credential-patterns`; these tests keep them from drifting again.
 */
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { describe, expect, it } from 'vitest';
import { detectSecrets } from '../src/prompt-firewall/index.js';
import {
  CREDENTIAL_PATTERNS,
  cloneCredentialPatterns,
} from '../src/runtime/credential-patterns.js';

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

/**
 * Behavioural parity with `@wrongstack/core` -> `security/secret-scrubber.ts`.
 *
 * `credential-patterns.ts` says to "keep the two key lists in step", and
 * nothing enforced it: the parity tests above compare secret-scanner against
 * prompt-firewall, which both read the SAME table, so they cannot see drift
 * against core. They had already drifted -- core carried `high_entropy_env`
 * (the `.env` / `export` / `docker-compose` shape) and this table did not, so
 * core scrubbed 4 of 5 probe samples and this table caught 0. Since
 * `secret-scanner` is default-ACTIVE and scans tool OUTPUT, `cat .env` put the
 * values in front of the model with nothing objecting.
 *
 * This is deliberately BEHAVIOURAL rather than a comparison of type-name
 * lists. A second hand-written list drifts from the first exactly the way the
 * comment did; a corpus both sides must detect cannot.
 */
const SHARED_CORPUS: Array<[string, string]> = [
  ['anthropic', 'sk-ant-api03-ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl_AA'],
  ['github pat', `ghp_${'a'.repeat(36)}`],
  ['github pat v2', `github_pat_${'b'.repeat(50)}`],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['gcp key', `AIza${'c'.repeat(35)}`],
  ['stripe', `sk_live_${'d'.repeat(24)}`],
  // F464: Stripe restricted keys and PyPI macaroon tokens passed both sides.
  ['stripe restricted', `rk_live_${'d'.repeat(24)}`],
  ['pypi token', `pypi-AgEIcHlwaS5vcmc${'e'.repeat(60)}`],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.ZmFrZXNpZ25hdHVyZXZhbHVlMDAw'],
  ['mongodb uri', 'mongodb://admin:hunter2@db.internal:27017'],
  ['json keyed', '{"api_key": "7f3a9c1e5b8d2f4a6c0e9b7d"}'],
  // The high_entropy_env family -- the half that had drifted.
  ['env aws secret', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['env generic token', 'MY_SERVICE_TOKEN=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c'],
  ['env quoted value', 'API_KEY="7f3a9c1e5b8d2f4a6c0e9b7d3a5f8c2e"'],
  ['shell export', 'export DATABASE_PASSWORD=s3cr3tp4ssw0rd9f8a7b6c'],
  ['env colon form', 'SERVICE_SECRET: 9f8a7b6c5d4e3f2a1b0c9d8e7f6a'],
  ['env key with a digit', 'R2_SECRET_ACCESS_KEY=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c'],
];

function pluginDetects(text: string): boolean {
  return cloneCredentialPatterns().some((pattern) => {
    pattern.regex.lastIndex = 0;
    return pattern.regex.test(text);
  });
}

describe('parity with core secret-scrubber', () => {
  const scrubber = new DefaultSecretScrubber();

  it.each(SHARED_CORPUS)('core scrubs %s', (_name, sample) => {
    expect(scrubber.scrub(sample)).not.toBe(sample);
  });

  it.each(SHARED_CORPUS)('the plugin table also detects %s', (_name, sample) => {
    expect(pluginDetects(sample)).toBe(true);
  });

  // Over-matching here is not a small cost: `secret-scanner` BLOCKS a
  // PreToolUse call on a hit, so a false positive stops ordinary work. The
  // key must be SCREAMING_CASE ending in a credential word and the value at
  // least 20 characters, which is what keeps ordinary config out.
  it.each([
    'DEBUG=true',
    'NODE_ENV=production',
    'PORT=3000',
    'LOG_LEVEL=info',
    'CI=1',
    'MY_KEY=short',
    'npm run build',
    'const apiKey = someLookup();',
    'KEY_ROTATION_INTERVAL=30',
  ])('does not fire on %s', (benign) => {
    expect(pluginDetects(benign)).toBe(false);
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
  // Real shape: a bot ID, a colon and exactly 35 secret characters. Built at
  // runtime so no token-shaped literal sits in the source.
  const token = ['1234567890', ':', 'AAH', 'x'.repeat(16), '_-', 'Y'.repeat(14)].join('');

  it.each([
    ['raw token', token, true],
    ['env assignment', `TELEGRAM_BOT_TOKEN=${token}`, true],
    ['quoted', `"${token}"`, true],
    ['api url', `https://api.telegram.org/bot${token}/getMe`, true],
    // #443: `grep -n` output is a line number, a colon and the line.
    ['grep -n output', '118:COMPARISON_TELEMETRY_DATABASE_URL_FOR_TESTS', false],
    ['grep -n long line', `4242:${'A'.repeat(35)}`, false],
    ['secret one short', token.slice(0, -1), false],
    ['secret one long', `${token}Z`, false],
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
    // JSON escapes inside the value are part of the value. Built at runtime so
    // no credential-shaped literal sits in the source.
    ...(
      [
        ['an escaped quote', ['pa', '"', 'ss-', 'a'.repeat(12)].join('')],
        ['an escaped backslash', ['C:', '\\', 'sec', '\\', 'a'.repeat(12)].join('')],
        ['an escaped newline', ['a', '\n', 'b-', 'a'.repeat(12)].join('')],
      ] as const
    ).map(
      ([label, value]) =>
        [`value with ${label}`, JSON.stringify({ [['pass', 'word'].join('')]: value }), true] as [
          string,
          string,
          boolean,
        ],
    ),
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

describe('Discord webhook URLs', () => {
  // The credential is the last path segment, so no key name or query marks it.
  const token = `Ab3_${'x9Y-'.repeat(15)}`;
  const url = `https://discord.com/api/webhooks/1122334455/${token}`;

  it('are caught by both plugin surfaces and the core scrubber', () => {
    expect(detectSecrets(`notify ${url}`, []).map((d) => d.kind)).toContain('discord_webhook');
    expect(CREDENTIAL_PATTERNS.some((p) => p.type === 'discord_webhook')).toBe(true);
    expect(new DefaultSecretScrubber().scrub(url)).not.toContain(token);
  });

  it('leave token-less Discord links alone', () => {
    expect(
      detectSecrets('see https://discord.com/api/webhooks', []).map((d) => d.kind),
    ).not.toContain('discord_webhook');
  });
});

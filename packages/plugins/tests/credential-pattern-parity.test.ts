/**
 * @wrongstack/plugins — credential detection parity.
 *
 * `secret-scanner` gates tool input/output; `prompt-firewall` gates the
 * outgoing provider request. Both build on `runtime/credential-patterns`;
 * these tests keep their credential coverage aligned.
 */
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_PATTERNS,
  cloneCredentialPatterns,
} from '../src/runtime/credential-patterns.js';
import { detectSecrets } from '../src/prompt-firewall/index.js';

function postgresUri(queryParts: readonly string[]): string {
  return ['postgresql', '://', 'localhost', '/app?', queryParts.join('')].join('');
}

describe('canonical credential table', () => {
  it('gives every pattern a unique id', () => {
    const types = CREDENTIAL_PATTERNS.map((pattern) => pattern.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('makes every pattern global so exec-loops terminate', () => {
    for (const pattern of CREDENTIAL_PATTERNS) {
      expect(pattern.regex.flags).toContain('g');
    }
  });

  it('uses no capturing groups in built-in patterns', () => {
    for (const pattern of CREDENTIAL_PATTERNS) {
      const groupCount = new RegExp(`${pattern.regex.source}|`).exec('')!.length - 1;
      expect({ type: pattern.type, groupCount }).toEqual({ type: pattern.type, groupCount: 0 });
    }
  });

  it('hands out independently-stateful copies', () => {
    const first = cloneCredentialPatterns();
    const second = cloneCredentialPatterns();
    first[0]!.regex.lastIndex = 42;
    expect(second[0]!.regex.lastIndex).toBe(0);
    expect(first[0]!.regex).not.toBe(second[0]!.regex);
  });
});

describe('prompt-firewall inherits the shared coverage', () => {
  it.each([
    ['gitlab_pat', ['glpat-', 'A'.repeat(20)].join('')],
    ['npm_token', ['npm_', 'b'.repeat(36)].join('')],
    ['sendgrid_key', ['SG.', 'a'.repeat(22), '.', 'b'.repeat(43)].join('')],
    ['digitalocean_token', ['dop_v1_', 'a'.repeat(64)].join('')],
    ['stripe_key', ['sk_live_', 'a'.repeat(24)].join('')],
  ])('detects %s in an outgoing request', (kind, sample) => {
    const found = detectSecrets(`context: ${sample}`, []);
    expect(found.map((detection) => detection.kind)).toContain(kind);
  });

  it('keeps the legacy kind names its consumers already log', () => {
    const github = detectSecrets(['ghp_', 'a'.repeat(36)].join(''), []);
    expect(github.map((detection) => detection.kind)).toContain('github-token');
    const aws = detectSecrets(['AKIA', 'A'.repeat(16)].join(''), []);
    expect(aws.map((detection) => detection.kind)).toContain('aws-access-key');
  });

  it('honours the allow list', () => {
    const sample = ['glpat-', 'A'.repeat(20)].join('');
    const found = detectSecrets(sample, [new RegExp(sample)]);
    expect(found.map((detection) => detection.kind)).not.toContain('gitlab_pat');
  });
});

describe('postgres_uri query-parameter password detection', () => {
  it.each([
    ['password as first param', postgresUri(['pass', 'word=', 'first-secret', '&sslmode=require']), true],
    [
      'password in middle',
      postgresUri(['user=alice&pass', 'word=', 'middle-secret', '&sslmode=require']),
      true,
    ],
    ['password as last param', postgresUri(['user=alice&pass', 'word=', 'last-secret']), true],
    [
      'percent-encoded password key',
      postgresUri(['user=alice&pass', '%77', 'ord=', 'encoded-secret', '&sslmode=require']),
      true,
    ],
    ['unrelated parameter', postgresUri(['appname=somepass']), false],
    ['no password parameter', postgresUri(['user=alice&sslmode=require']), false],
  ] as const)('detects %s', (_label, uri, shouldMatch) => {
    const pattern = cloneCredentialPatterns().find((entry) => entry.type === 'postgres_uri');
    expect(pattern).toBeDefined();
    expect({ uri, matched: pattern?.regex.test(uri) }).toEqual({ uri, matched: shouldMatch });
  });
});

describe('aws-secret-key detection', () => {
  const alnumKey = 'wJalrXUtnFEMIKbPxRfiCYEXAMPLEKEY12345678';
  const base64Key = ['wJalrXUtnFEMIKbPxRfiCYEXAMPLEKEY123456', '/+'].join('');

  it.each([
    ['AWS_SECRET_ACCESS_KEY assignment', `AWS_SECRET_ACCESS_KEY=${alnumKey}`],
    ['lowercase yaml key', `aws_secret_access_key: ${alnumKey}`],
    ['quoted value', `aws_secret_key = "${alnumKey}"`],
    ['key ending in base64 padding chars', `AWS_SECRET_ACCESS_KEY=${base64Key}`],
  ])('detects %s', (_label, text) => {
    expect(detectSecrets(text, []).map((detection) => detection.kind)).toContain('aws-secret-key');
  });

  it('does not fire on an unrelated 40-char token', () => {
    const found = detectSecrets(`sha=${'a'.repeat(40)}`, []);
    expect(found.map((detection) => detection.kind)).not.toContain('aws-secret-key');
  });
});

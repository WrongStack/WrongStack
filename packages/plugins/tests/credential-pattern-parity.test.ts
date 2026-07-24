/**
 * @wrongstack/plugins — credential detection parity.
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
    // The combined regex in secret-scanner maps a capture-group index back
    // to the pattern that fired. An inner group in a built-in shifts that
    // mapping for every pattern after it.
    for (const p of CREDENTIAL_PATTERNS) {
      const groupCount = new RegExp(`${p.regex.source}|`).exec('')!.length - 1;
      expect({ type: p.type, groupCount }).toEqual({ type: p.type, groupCount: 0 });
    }
  });

  it('hands out independently-stateful copies', () => {
    const a = cloneCredentialPatterns();
    const b = cloneCredentialPatterns();
    a[0]!.regex.lastIndex = 42;
    // A stale lastIndex leaking between consumers would make one plugin's
    // scan start midway through another's input.
    expect(b[0]!.regex.lastIndex).toBe(0);
    expect(a[0]!.regex).not.toBe(b[0]!.regex);
  });
});

describe('prompt-firewall inherits the shared coverage', () => {
  it.each([
    ['gitlab_pat', `glpat-${'A'.repeat(20)}`],
    ['npm_token', `npm_${'b'.repeat(36)}`],
    ['sendgrid_key', `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`],
    ['digitalocean_token', `dop_v1_${'a'.repeat(64)}`],
    ['stripe_key', `sk_live_${'a'.repeat(24)}`],
  ])('detects %s in an outgoing request', (kind, sample) => {
    const found = detectSecrets(`context: ${sample}`, []);
    expect(found.map((d) => d.kind)).toContain(kind);
  });

  it('keeps the legacy kind names its consumers already log', () => {
    const github = detectSecrets(`ghp_${'a'.repeat(36)}`, []);
    expect(github.map((d) => d.kind)).toContain('github-token');
    const aws = detectSecrets(`AKIA${'A'.repeat(16)}`, []);
    expect(aws.map((d) => d.kind)).toContain('aws-access-key');
  });

  it('honours the allow list', () => {
    const sample = `glpat-${'A'.repeat(20)}`;
    const found = detectSecrets(sample, [new RegExp(sample)]);
    expect(found.map((d) => d.kind)).not.toContain('gitlab_pat');
  });
});

describe('postgres_uri query-parameter password detection', () => {
  // The postgres_uri pattern has two alternatives:
  //   1. user:password@host  (credential in authority)
  //   2. query-param password=
  // The second alternative uses a repeating param group with a negative
  // lookahead to avoid consuming password=value& when another param follows.
  it.each([
    ['password as last param (no other params)', 'postgres://host/db?password=secret', true],
    ['password as last param (with preceding params)', 'postgres://host/db?user=alice&password=secret', true],
    ['password in middle (followed by another param)', 'postgres://host/db?user=alice&password=secret&sslmode=require', true],
    ['uripassword (no colon)', 'postgres://host/db?appname=somepass', false],
    ['no password param', 'postgres://host/db?user=alice&sslmode=require', false],
  ] as const)('detects %s', (_label, uri, shouldMatch) => {
    const found = cloneCredentialPatterns().find((p) => p.type === 'postgres_uri');
    expect(found).toBeDefined();
    expect({ uri, matched: found?.regex.test(uri) }).toEqual({
      uri,
      matched: shouldMatch,
    });
  });
});

describe('aws-secret-key detection', () => {
  // The previous pattern required the literal "aws" to appear AFTER the
  // key and wrapped the 40-char run in `\b`. Real keys are written as
  // `AWS_SECRET_ACCESS_KEY=<key>` (context first) and routinely end in
  // `+` or `/`, where `\b` cannot hold — so it never fired on a real key.
  const alnumKey = 'wJalrXUtnFEMIKbPxRfiCYEXAMPLEKEY12345678';
  const base64Key = `${'wJalrXUtnFEMIKbPxRfiCYEXAMPLEKEY123456'}/+`;

  it.each([
    ['AWS_SECRET_ACCESS_KEY assignment', `AWS_SECRET_ACCESS_KEY=${alnumKey}`],
    ['lowercase yaml key', `aws_secret_access_key: ${alnumKey}`],
    ['quoted value', `aws_secret_key = "${alnumKey}"`],
    ['key ending in base64 padding chars', `AWS_SECRET_ACCESS_KEY=${base64Key}`],
  ])('detects %s', (_label, text) => {
    expect(detectSecrets(text, []).map((d) => d.kind)).toContain('aws-secret-key');
  });

  it('does not fire on an unrelated 40-char token', () => {
    // A bare hash with no AWS context must not be reported — this is the
    // false-positive guard that justifies requiring nearby context.
    const found = detectSecrets(`sha=${'a'.repeat(40)}`, []);
    expect(found.map((d) => d.kind)).not.toContain('aws-secret-key');
  });
});

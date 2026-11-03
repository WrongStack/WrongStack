/**
 * Regression: a `--flag:VALUE` credential was never captured by the named
 * long-flag patterns.
 *
 * The shared separator rule (module docblock) says the separator is the first
 * character after the flag NAME and may be `=`, whitespace, `:` or `,` — but
 * the pattern lists only declared `[=\s,]`. With `:` excluded from the match,
 * `--password:hunter2` matched just the bare flag name, whose boundary is the
 * empty string, so neither profile's separator branch ran:
 *
 *   - COMMAND (`/ps`, crash dumps, telemetry) printed the value verbatim
 *     (`--pin:4815` has no env-style label to backstop it), and
 *   - OUTBOUND (Telegram notifications) wiped the flag name into
 *     `**redacted**` and emitted `:hunter2` — the worst shape, because the
 *     text reads as redacted while the credential is still on the wire.
 *
 * The value is assembled at runtime so this file holds no credential-shaped
 * literal for the secret-scanner hook.
 */
import { describe, expect, it } from 'vitest';
import { redactCommand, redactSecrets } from '../src/redact-command.js';

const SECRET = ['colon', '-regression-', 'value'].join('');

describe('colon-separated sensitive long flags', () => {
  it.each([
    [
      '--password',
      `redis-cli --password:${SECRET} get session`,
      `redis-cli --password:[REDACTED] get session`,
    ],
    ['--db-password', `db --db-password:${SECRET} up`, `db --db-password:[REDACTED] up`],
    ['--auth-token', `api --auth-token:${SECRET}`, `api --auth-token:[REDACTED]`],
    ['--api-key', `api --api-key:${SECRET}`, `api --api-key:[REDACTED]`],
    ['--passphrase', `vault --passphrase:${SECRET}`, `vault --passphrase:[REDACTED]`],
    ['--credential', `tool --credential:${SECRET}`, `tool --credential:[REDACTED]`],
    ['--jwt', `tool --jwt:${SECRET}`, `tool --jwt:[REDACTED]`],
    ['--github-token', `gh --github-token:${SECRET}`, `gh --github-token:[REDACTED]`],
  ])('%s:VALUE is redacted in both profiles', (_flag, input, expected) => {
    expect(redactCommand(input)).toBe(expected);
    expect(redactSecrets(input)).toBe(expected);
  });

  it('keeps the value of a bare keyword the env-style backstop does not cover', () => {
    // `pin` is in KEYWORDS but not in the env-var label list, so the command
    // profile had no second pattern to fall back on.
    expect(redactCommand('run --pin:4815 now')).toBe('run --pin:[REDACTED] now');
    expect(redactSecrets('run --pin:4815 now')).toBe('run --pin:[REDACTED] now');
  });

  it('takes the quoted and whitespace-padded colon forms whole', () => {
    expect(redactSecrets(`run --password:"${SECRET} two" now`)).toBe(
      'run --password:[REDACTED] now',
    );
    expect(redactSecrets(`run --password:\t${SECRET} now`)).toBe('run --password:[REDACTED] now');
    expect(redactCommand(`run --password: \t${SECRET} now`)).toBe('run --password:[REDACTED] now');
  });

  it('covers a long high-entropy value behind a keyword-in-the-middle flag', () => {
    // `token` is not the final hyphen segment, so only the shared high-entropy
    // pattern can see this one; its separator class had to admit `:` as well.
    const long = 'A'.repeat(48);
    expect(redactSecrets(`run --x-token-thing:${long} now`)).not.toContain(long);
    expect(redactCommand(`run --x-token-thing:${long} now`)).not.toContain(long);
  });

  it('leaves a keyword-in-the-middle flag name readable', () => {
    // The separator must sit immediately after the flag NAME; `--token-file`
    // names a file, not a secret.
    expect(redactCommand('run --token-file:/tmp/x now')).toBe('run --token-file:/tmp/x now');
  });
});

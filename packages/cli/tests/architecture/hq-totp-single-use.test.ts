/**
 * A TOTP code must be single-use across EVERY endpoint that accepts one.
 *
 * A code stays valid for its time step plus the verification window — about
 * 90 seconds. The single-use record (`totpLastUsedCounter`) is what stops an
 * observed code from being presented twice, and it only works if every
 * verification site shares one counter.
 *
 * It shipped applied at exactly one of three sites. `/api/login/verify`
 * advanced the counter; `/api/auth/totp/disable` and `/api/auth/password`
 * called the counter-less `verifyTotp`. So a code the operator had just typed
 * into the login form — observed over the shoulder, or replayed from a
 * phished prompt — was still good at the other two for the rest of its
 * window, where it removes 2FA and every recovery code, or rotates the
 * password and cookie secret. One factor, two very different blast radii.
 *
 * The fix routes all three through `consumeTotpCode` in `common.ts`. This
 * test pins that: it walks the auth router source the way the agent-loop and
 * kanban-governance parity tests do, so a fourth verification site cannot be
 * added with its own inline check.
 *
 * It also asserts, on synthetic source, that the walk actually FAILS on a
 * violation. Two guards in this repo turned out to be structurally incapable
 * of failing — one greppped for a delimiter and so could only catch a
 * duplicated fence, never a missing one; another passed its regex through a
 * shell and matched zero lines for its entire life. A guard you have only
 * watched pass is not evidence.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateTotp, generateTotpSecret } from '@wrongstack/core/security';
import { consumeTotpCode } from '../../src/hq-server/routes/auth/common.js';
import type { HqRouterMutableAuth } from '../../src/hq-server/types.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const AUTH_ROUTES = path.join(repositoryRoot, 'packages/cli/src/hq-server/routes/auth');

/**
 * The single authority. Only this file may reach for the raw counter-aware
 * primitive; everything else calls `consumeTotpCode`.
 */
const AUTHORITY = 'common.ts';

/**
 * The one documented exception: enrolment (`/api/auth/totp/confirm`) verifies
 * against `totpPendingSecret`, which is not yet the active secret and has no
 * shared counter to advance. Replaying an enrolment code re-confirms an
 * enrolment the caller already completed, which grants nothing.
 */
const ENROLMENT_EXCEPTION = { file: 'totp-routes.ts', argument: 'pendingSecret' } as const;

/**
 * `verifyTotp(...)` / `verifyTotpCounter(...)` at a call position, capturing
 * the whole argument list — the enrolment exception is identified by the
 * SECOND argument (the secret it checks against), not the first (the code).
 */
const RAW_VERIFY_CALL = /\bverifyTotp(?:Counter)?\s*\(([^)]*)\)/g;

interface RawCall {
  readonly file: string;
  readonly line: number;
  readonly args: string;
  readonly text: string;
}

async function findRawVerifyCalls(dir: string): Promise<RawCall[]> {
  const found: RawCall[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = await fs.readFile(path.join(dir, entry.name), 'utf8');
    found.push(...collectRawVerifyCalls(entry.name, source));
  }
  return found;
}

/** Pulled out so the self-check below can run it over synthetic source. */
function collectRawVerifyCalls(file: string, source: string): RawCall[] {
  const found: RawCall[] = [];
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trimStart();
    // Import lists and prose mentions are not call sites.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import')) return;
    RAW_VERIFY_CALL.lastIndex = 0;
    for (const match of text.matchAll(RAW_VERIFY_CALL)) {
      found.push({ file, line: index + 1, args: (match[1] ?? '').trim(), text: text.trim() });
    }
  });
  return found;
}

describe('HQ TOTP codes are single-use at every verification site', () => {
  it('routes every check of the ACTIVE secret through consumeTotpCode', async () => {
    const rawCalls = await findRawVerifyCalls(AUTH_ROUTES);

    const offenders = rawCalls.filter((call) => {
      if (call.file === AUTHORITY) return false;
      return !(
        call.file === ENROLMENT_EXCEPTION.file && call.args.includes(ENROLMENT_EXCEPTION.argument)
      );
    });

    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.text}`),
      'A TOTP code must be burned when it is accepted. Call `consumeTotpCode(code, ' +
        'mutableAuth, dataDir, applyAuthFile)` from `./common.js` instead of `verifyTotp` — ' +
        'it verifies, rejects a replay, and advances the shared single-use counter. ' +
        'Offending sites:',
    ).toEqual([]);
  });

  it('still finds the authority itself, so the walk is looking in the right place', async () => {
    const rawCalls = await findRawVerifyCalls(AUTH_ROUTES);
    // If this ever empties out, `consumeTotpCode` has stopped verifying and
    // the test above would pass vacuously.
    expect(rawCalls.filter((c) => c.file === AUTHORITY).length).toBeGreaterThan(0);
  });

  it('self-check: the walk fails when a violation is injected', () => {
    const injected = collectRawVerifyCalls(
      'password-routes.ts',
      ['const ok = verifyTotp(body.code, mutableAuth.totpSecret);'].join('\n'),
    );
    const offenders = injected.filter(
      (call) =>
        call.file !== AUTHORITY &&
        !(call.file === ENROLMENT_EXCEPTION.file && call.args.includes(ENROLMENT_EXCEPTION.argument)),
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.args).toBe('body.code, mutableAuth.totpSecret');
  });

  it('self-check: the documented enrolment exception is still exempt', () => {
    const enrolment = collectRawVerifyCalls(
      'totp-routes.ts',
      'if (!verifyTotp(body.code, pendingSecret)) {',
    );
    // The exception keys on the SECOND argument being the pending secret, so a
    // line whose first argument is the code must still be recognised.
    expect(enrolment).toHaveLength(1);
    expect(enrolment[0]?.args).toContain(ENROLMENT_EXCEPTION.argument);
  });
});

describe('consumeTotpCode', () => {
  function mutableAuthWith(secret: string): HqRouterMutableAuth {
    return { totpSecret: secret, browserTokens: new Set() } as unknown as HqRouterMutableAuth;
  }

  // `dataDir` points nowhere: the persistence step is deliberately
  // best-effort, so the in-memory counter must advance regardless.
  const NO_DISK = path.join(repositoryRoot, 'packages/cli/tests/.does-not-exist');

  it('accepts a fresh code once and rejects the same code as replayed', async () => {
    const secret = generateTotpSecret();
    const auth = mutableAuthWith(secret);
    const code = generateTotp(secret);

    expect(await consumeTotpCode(code, auth, NO_DISK, () => {})).toBe('ok');
    expect(auth.totpLastUsedCounter).toBeGreaterThan(0);
    expect(await consumeTotpCode(code, auth, NO_DISK, () => {})).toBe('replayed');
  });

  it('rejects a wrong code as invalid, and does not advance the counter', async () => {
    const auth = mutableAuthWith(generateTotpSecret());
    expect(await consumeTotpCode('000000', auth, NO_DISK, () => {})).toBe('invalid');
    expect(auth.totpLastUsedCounter).toBeUndefined();
  });

  it('rejects when no secret is configured', async () => {
    const auth = { browserTokens: new Set() } as unknown as HqRouterMutableAuth;
    expect(await consumeTotpCode('000000', auth, NO_DISK, () => {})).toBe('invalid');
  });
});

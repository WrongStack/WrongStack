/**
 * WS-050 — the HQ trust boundary's only deny rule could never fire.
 *
 * `createCompatibilityTrustBoundary` denies exactly one thing:
 * `actor.kind === 'remote-client'` at `risk === 'critical'`. `authorizeHqCommand`
 * hardcoded `actor: { kind: 'user' }`, so that rule was unreachable from HQ.
 * A boundary whose single rule can never fire is not defence in depth, it is
 * decoration.
 *
 * The actor kind is now derived from how the caller authenticated. Getting
 * that mapping wrong in the other direction would have been worse than the
 * original bug — it would deny run-command to every dashboard user — so the
 * shape was checked against the real auth flow rather than reasoned about:
 *
 *   - The dashboard's primary flow is a bootstrap code exchanged for an
 *     HttpOnly session cookie. Those sessions DO carry a `tokenId`
 *     (`auth-handlers.ts` passes `tokenId: entry.tokenId`), so a tempting
 *     "cookie without a tokenId means a human" rule would have classified
 *     every normal dashboard user as remote.
 *   - Raw bearer tokens are the legacy `?token=` / manual-entry path and any
 *     script hitting the HTTP API. A credential that can be pasted into a
 *     script is not a person at a console.
 *
 * Deliberate consequence, pinned below: bearer-token callers lose
 * `run-command` (the only `critical` capability here) and keep `enqueue`
 * (`high`).
 */
import type { HqCommand } from '@wrongstack/core/hq';
import { createCompatibilityTrustBoundary } from '@wrongstack/core/security';
import { describe, expect, it, vi } from 'vitest';
import { authorizeHqCommand } from '../src/hq-server/trust-boundary.js';

const target = { clientId: 'c1', projectId: 'p1', kind: 'tui' } as never;

async function authorize(
  authMethod: 'session' | 'bearer-token',
  command: HqCommand,
): Promise<{ allowed: boolean; reason: string }> {
  // The console.warn audit line is noise for these assertions.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await authorizeHqCommand({
      boundary: createCompatibilityTrustBoundary(),
      command,
      commandId: 'cmd-1',
      enqueuedBy: 'operator',
      authMethod,
      target,
    });
  } finally {
    warn.mockRestore();
  }
}

const runCommand = { type: 'run-command', command: 'ls' } as unknown as HqCommand;
const enqueue = { type: 'enqueue-prompt' } as unknown as HqCommand;

describe('actor provenance drives the boundary (WS-050)', () => {
  it('denies a bearer-token caller the critical run-command', async () => {
    // The deny rule, finally reachable.
    const result = await authorize('bearer-token', runCommand);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/remote-client/);
  });

  it('still allows a cookie-session caller to run-command', async () => {
    // The dashboard path. If this ever fails, normal HQ use is broken — which
    // is a worse outcome than the bug being fixed.
    const result = await authorize('session', runCommand);
    expect(result.allowed).toBe(true);
  });

  it('leaves non-critical commands allowed for bearer callers', async () => {
    // `enqueue` is `high`, not `critical`, so the tightening is narrow by
    // design rather than a blanket lockout of token automation.
    const result = await authorize('bearer-token', enqueue);
    expect(result.allowed).toBe(true);
  });

  it('allows non-critical commands for cookie callers too', async () => {
    expect((await authorize('session', enqueue)).allowed).toBe(true);
  });
});

describe('the rule is genuinely load-bearing (WS-050)', () => {
  it('a boundary with the deny disabled allows the bearer run-command', async () => {
    // Proves the deny above comes from the policy rather than from some other
    // check incidentally rejecting the fixture.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await authorizeHqCommand({
        boundary: createCompatibilityTrustBoundary({ denyCriticalRiskRemoteClient: false }),
        command: runCommand,
        commandId: 'cmd-2',
        enqueuedBy: 'operator',
        authMethod: 'bearer-token',
        target,
      });
      expect(result.allowed).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

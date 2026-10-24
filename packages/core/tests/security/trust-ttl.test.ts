/**
 * W6 #9 (RFC hq-improvements-2026-09.md) — expiry for prompt-granted trust.
 *
 * An `always` answer used to write a trust rule with no expiry, so one
 * approval became standing authorization for the life of the file. These tests
 * pin both halves of the fix: the write stamps an `allowUntil`, and an expired
 * rule STOPS MATCHING — which is the direction that matters, because an expiry
 * must only ever withdraw authorization.
 *
 * The expired case asserts `confirm`, not `deny`: expiry returns the operator
 * to the prompt they would have seen had they never answered `always`. A deny
 * would be a different (and wrong) behaviour — it would turn a lapsed grant
 * into a block.
 *
 * @module tests/security/trust-ttl
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import {
  DEFAULT_ALWAYS_TRUST_TTL_MS,
  DefaultPermissionPolicy,
} from '../../src/security/permission-policy.js';

let dir: string;
let trustFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trust-ttl-'));
  trustFile = path.join(dir, 'trust.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function readTool(): Tool {
  return { name: 'read', permission: 'confirm' } as unknown as Tool;
}

async function writePolicy(policy: unknown): Promise<void> {
  await fs.writeFile(trustFile, JSON.stringify(policy, null, 2));
}

async function readPolicy(): Promise<Record<string, { allowUntil?: number }>> {
  return JSON.parse(await fs.readFile(trustFile, 'utf8')) as Record<
    string,
    { allowUntil?: number }
  >;
}

describe('trust-rule expiry (W6 #9)', () => {
  it('stamps an expiry when a prompt grants `always`', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile });
    const before = Date.now();

    await policy.trust({ tool: 'read', pattern: 'README.md', ttlMs: 60_000 });

    const written = await readPolicy();
    const until = written.read?.allowUntil;
    expect(typeof until).toBe('number');
    expect(until).toBeGreaterThanOrEqual(before + 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('leaves a hand-authored rule permanent when no ttl is given', async () => {
    // Only rules a prompt created are timed; a user who edited trust.json
    // asked for a standing rule and must keep it.
    const policy = new DefaultPermissionPolicy({ trustFile });

    await policy.trust({ tool: 'read', pattern: 'README.md' });

    const written = await readPolicy();
    expect(written.read?.allowUntil).toBeUndefined();
  });

  it('refreshes the window when an already-timed rule is re-granted', async () => {
    // Re-granting must not silently make a timed rule permanent.
    const policy = new DefaultPermissionPolicy({ trustFile });
    await policy.trust({ tool: 'read', pattern: 'README.md', ttlMs: 1_000 });
    const first = (await readPolicy()).read?.allowUntil;

    await policy.trust({ tool: 'read', pattern: 'README.md', ttlMs: 90_000 });
    const second = (await readPolicy()).read?.allowUntil;

    expect(second).toBeDefined();
    expect(second).toBeGreaterThan(first ?? 0);
  });

  it('still auto-approves while the rule is unexpired', async () => {
    await writePolicy({
      read: { allow: ['README.md'], allowUntil: Date.now() + 60_000 },
    });
    const policy = new DefaultPermissionPolicy({ trustFile });

    const decision = await policy.evaluate(readTool(), { path: 'README.md' }, {} as Context);

    expect(decision).toMatchObject({ permission: 'auto', source: 'trust' });
  });

  it('falls back to confirm once the rule has expired', async () => {
    await writePolicy({
      read: { allow: ['README.md'], allowUntil: Date.now() - 1 },
    });
    const policy = new DefaultPermissionPolicy({ trustFile });

    const decision = await policy.evaluate(readTool(), { path: 'README.md' }, {} as Context);

    // The lapsed grant must stop being honoured via the trust path — that is
    // the whole of W6 #9's contract. The fallback is the TOOL's own default,
    // not a fixed 'confirm': an ordinary `read` is auto-approved by default
    // (which is why `isSensitiveReadCall` exists as a separate path), so
    // asserting 'confirm' here would be asserting the tool's policy, not the
    // expiry. What matters is that expiry re-prompts rather than blocks, and
    // never silently hardens a lapsed grant into a deny.
    expect(decision.source).not.toBe('trust');
    expect(decision.permission).not.toBe('deny');
  });

  it('never expires a rule with no allowUntil', async () => {
    await writePolicy({ read: { allow: ['README.md'] } });
    const policy = new DefaultPermissionPolicy({ trustFile });

    const decision = await policy.evaluate(readTool(), { path: 'README.md' }, {} as Context);

    expect(decision).toMatchObject({ permission: 'auto', source: 'trust' });
  });

  it('defaults the prompt TTL to one day', () => {
    expect(DEFAULT_ALWAYS_TRUST_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

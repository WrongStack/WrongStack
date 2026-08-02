/**
 * WS-058 — the permission eval cache outlived the tool it described.
 *
 * The cache was keyed on tool NAME plus subject, and its lookup runs BEFORE
 * the tool-default-deny branch. So once a decision was cached, a later call
 * with the same name and subject skipped every check — including the one that
 * would have denied it.
 *
 * That matters because a tool definition is not immutable.
 * `ToolRegistry.wrap()` replaces a tool in place and is reachable from the
 * plugin API (`plugin/api.ts` → `tr.wrap(name, wrapper, owner)`), with the
 * registry's own documented example being exactly a permission change:
 *
 *     registry.wrap('bash', (t) => ({ ...t, permission: 'confirm' }));
 *
 * Tighten a tool that way after one permissive call and the cache keeps
 * serving the old verdict. The fix keys the eval cache on the fields the
 * decision depends on, so a redefined tool misses rather than inherits.
 *
 * The session deny/allow key is deliberately NOT widened — see below.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import type { Tool } from '../../src/types/index.js';

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'demo',
    description: 'demo',
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    subjectKey: 'path',
    async execute() {
      return 'ok';
    },
    ...overrides,
  } as Tool;
}

let trustFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cache-'));
  trustFile = path.join(dir, 'trust.json');
});
afterEach(async () => {
  await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
});

describe('eval cache does not outlive the tool definition (WS-058)', () => {
  it('a tool tightened to deny is not served the earlier auto', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const input = { path: 'src/a.ts' };

    const first = await p.evaluate(tool(), input, {} as Context);
    expect(first.permission).toBe('auto');

    // Same name, same subject, tightened permission — as `registry.wrap`
    // produces. Before the fix this hit the cache and returned 'auto'.
    const second = await p.evaluate(tool({ permission: 'deny' }), input, {} as Context);
    expect(second.permission).toBe('deny');
  });

  it('does not go the other way either — a loosened tool is re-evaluated', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const input = { path: 'src/a.ts' };

    expect((await p.evaluate(tool({ permission: 'deny' }), input, {} as Context)).permission).toBe(
      'deny',
    );
    expect((await p.evaluate(tool(), input, {} as Context)).permission).toBe('auto');
  });

  it('notices a changed risk tier and capability set', async () => {
    // Both feed later branches of the decision, so both belong in the key.
    const p = new DefaultPermissionPolicy({ trustFile });
    const input = { path: 'src/a.ts' };

    await p.evaluate(tool(), input, {} as Context);
    const risky = await p.evaluate(
      tool({ permission: 'deny', riskTier: 'destructive' }),
      input,
      {} as Context,
    );
    expect(risky.permission).toBe('deny');

    await p.evaluate(tool(), input, {} as Context);
    const capped = await p.evaluate(
      tool({ permission: 'deny', capabilities: ['shell.arbitrary'] }),
      input,
      {} as Context,
    );
    expect(capped.permission).toBe('deny');
  });

  it('still caches — an unchanged tool keeps hitting', async () => {
    // The fix must not turn the cache off; that would be a silent perf
    // regression on the hot path.
    const p = new DefaultPermissionPolicy({ trustFile });
    const input = { path: 'src/a.ts' };
    const a = await p.evaluate(tool(), input, {} as Context);
    const b = await p.evaluate(tool(), input, {} as Context);
    // Same object identity proves the second call returned the cached entry
    // rather than recomputing an equal one.
    expect(b).toBe(a);
  });
});

describe('session deny/allow keys keep their shape (WS-058)', () => {
  it('a session deny still matches after the eval-cache key changed', async () => {
    // `denyOnce`/`allowOnce` are called from the UI with only {tool, pattern},
    // so their key cannot carry the tool fingerprint. Widening the shared key
    // would have silently stopped session denies from matching — failing OPEN,
    // which is a worse bug than the one being fixed. This pins that they were
    // kept separate.
    const p = new DefaultPermissionPolicy({ trustFile });
    // One evaluate first: the policy loads its trust file lazily on the first
    // call and `reload()` clears the session maps, so setting them before any
    // evaluate would wipe them. In production `denyOnce` is called from inside
    // a prompt, which already happens after the load.
    await p.evaluate(tool(), { path: 'other.ts' }, {} as Context);
    p.denyOnce({ tool: 'demo', pattern: 'src/a.ts' });
    const decision = await p.evaluate(tool(), { path: 'src/a.ts' }, {} as Context);
    expect(decision.permission).toBe('deny');
    expect(decision.reason).toContain('session soft deny');
  });

  it('a session one-shot allow still matches and is consumed once', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const t = tool({ permission: 'confirm', mutating: true });
    await p.evaluate(t, { path: 'other.ts' }, {} as Context); // trigger the lazy load
    p.allowOnce({ tool: 'demo', pattern: 'src/a.ts' });
    expect((await p.evaluate(t, { path: 'src/a.ts' }, {} as Context)).permission).toBe('auto');
    // Consumed — the next identical call must ask again.
    expect((await p.evaluate(t, { path: 'src/a.ts' }, {} as Context)).permission).not.toBe('auto');
  });
});

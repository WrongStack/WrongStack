/**
 * `mutating` and `capabilities` answer the same question, and they disagreed.
 *
 * `permission-policy.ts` decides with `tool.mutating || …`.
 * `readonly-permission-policy.ts` decided with the capability list alone. A
 * repo-wide count found 154 tools declaring `mutating: true`, of which 121
 * carried no mutation capability — so read-only mode let every one of them run
 * while the ordinary policy treated them as writes. Capability labels are
 * opt-in metadata; nothing had ever required them to agree with the flag that
 * sits beside them in the same object literal.
 *
 * The fix was one line (`if (tool.mutating === true) return true`). This test
 * is what keeps it honest: it drives the REAL policy over the REAL builtin
 * tool pack, so a new mutating tool is covered the day it is registered
 * rather than the day someone remembers to label it.
 *
 * The second half is a ratchet. The tools that are mutating without a mutation
 * capability are pinned by name with a reason — they mutate something that is
 * not the filesystem (a live browser page, the process working directory), so
 * their labels are correct and the flag is what read-only mode needs. A new
 * name appearing in that list is the signal to look: it is usually a tool that
 * writes and forgot to say so.
 */

import type { Context } from '@wrongstack/core/agent';
import { ReadOnlyPermissionPolicy } from '@wrongstack/core/security';
import type { PermissionDecision, PermissionPolicy, Tool } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { builtinToolsPack } from '../src/pack.js';

const TOOLS = builtinToolsPack.tools.filter((t): t is Tool => t != null);

/** Mutation capabilities, mirrored from `readonly-permission-policy.ts`. */
const MUTATION_CAPABILITIES = new Set([
  'fs.write',
  'fs.write.outside-project',
  'memory.write',
  'memory.delete',
  'shell.arbitrary',
  'shell.restricted',
  'shell.exec',
  'tool.mutate.any',
  'config.mutate',
  'package.install',
  'subagent.spawn',
]);

/** Inner policy that always allows, so any deny came from the wrapper. */
const allowAll: PermissionPolicy = {
  evaluate: async (): Promise<PermissionDecision> => ({ permission: 'auto', source: 'trust' }),
  trust: async () => undefined,
  deny: async () => undefined,
  denyOnce: () => undefined,
  allowOnce: () => undefined,
  reload: async () => undefined,
};

function readOnlyContext(): Context {
  return { meta: { readOnly: true } } as unknown as Context;
}

/**
 * Tools that declare `mutating: true` without a mutation capability, with the
 * reason each is correct as written. This list should shrink or stay put.
 */
const MUTATING_WITHOUT_FS_CAPABILITY: Record<string, string> = {
  browser_open: 'drives a live browser page, not the filesystem',
  browser_navigate: 'drives a live browser page, not the filesystem',
  browser_screenshot: 'drives a live browser page, not the filesystem',
  browser_click: 'drives a live browser page, not the filesystem',
  browser_type: 'drives a live browser page, not the filesystem',
  browser_select: 'drives a live browser page, not the filesystem',
  browser_press: 'drives a live browser page, not the filesystem',
  browser_hover: 'drives a live browser page, not the filesystem',
  browser_drag: 'drives a live browser page, not the filesystem',
  browser_upload: 'reads a local file and posts it to a live page; no local write',
  outdated: 'queries the registry for newer versions; writes nothing',
  batch_tool_use: 'meta-tool — the mutation belongs to whatever it batches',
  set_working_dir: 'mutates process state (cwd), not the filesystem',
};

describe('read-only mode blocks every mutating builtin tool', () => {
  const policy = new ReadOnlyPermissionPolicy(allowAll, process.cwd());
  const mutating = TOOLS.filter((t) => t.mutating === true);

  it('the builtin pack really does declare mutating tools', () => {
    // Guards the suite below: an empty set would make every case vacuous.
    expect(mutating.length).toBeGreaterThan(10);
  });

  it.each(mutating.map((t) => [t.name, t] as const))(
    '%s is denied in read-only mode',
    async (_name, tool) => {
      const decision = await policy.evaluate(tool, {}, readOnlyContext());
      expect(
        decision.permission,
        `${tool.name} declares mutating: true but read-only mode let it through. ` +
          `hasMutationCapability() must trust the flag, not only the capability list.`,
      ).toBe('deny');
      expect(decision.source).toBe('readonly_mode');
    },
  );

  it('states a usable reason for a tool blocked on the flag alone', async () => {
    const flagOnly = mutating.find(
      (t) => !(t.capabilities ?? []).some((c) => MUTATION_CAPABILITIES.has(c)),
    );
    expect(flagOnly, 'expected at least one flag-only mutating tool').toBeDefined();
    const decision = await policy.evaluate(flagOnly!, {}, readOnlyContext());
    // Not "requires mutation capabilities ()" — an empty list reads as a bug.
    expect(decision.reason).not.toMatch(/\(\)/);
    expect(decision.reason).toContain('read-only mode');
  });

  it('leaves non-mutating tools to the inner policy', async () => {
    const readOnlyTools = TOOLS.filter(
      (t) =>
        t.mutating !== true && !(t.capabilities ?? []).some((c) => MUTATION_CAPABILITIES.has(c)),
    );
    expect(readOnlyTools.length).toBeGreaterThan(5);
    for (const tool of readOnlyTools) {
      const decision = await policy.evaluate(tool, {}, readOnlyContext());
      expect(decision.permission, `${tool.name} was blocked but mutates nothing`).not.toBe('deny');
    }
  });
});

describe('mutating / capabilities labelling stays in agreement', () => {
  const unlabelled = TOOLS.filter(
    (t) => t.mutating === true && !(t.capabilities ?? []).some((c) => MUTATION_CAPABILITIES.has(c)),
  ).map((t) => t.name);

  it('no new tool is mutating without either a capability or a stated reason', () => {
    const unexplained = unlabelled.filter((n) => !(n in MUTATING_WITHOUT_FS_CAPABILITY));
    expect(
      unexplained,
      `these declare mutating: true with no mutation capability: ${unexplained.join(', ')}. ` +
        `Add the capability if the tool writes, or add it to ` +
        `MUTATING_WITHOUT_FS_CAPABILITY with the reason it does not.`,
    ).toEqual([]);
  });

  it('the reason list has no stale entries', () => {
    const stale = Object.keys(MUTATING_WITHOUT_FS_CAPABILITY).filter(
      (n) => !unlabelled.includes(n),
    );
    expect(
      stale,
      `now labelled (or no longer mutating) — drop from the list: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('no mutating tool auto-approves', () => {
    const auto = TOOLS.filter(
      (t) => t.mutating === true && (t.permission ?? 'auto') === 'auto',
    ).map((t) => t.name);
    expect(auto, `mutating tools at permission: 'auto' run unprompted: ${auto.join(', ')}`).toEqual(
      [],
    );
  });
});

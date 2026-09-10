/**
 * Tests for the in-project policy + cloud-sync contract decisions
 * around `tools.autoThin` and `tools.disabledToolMeta`.
 *
 * The policy posture is operator-owned, repo-denied: a checked-out
 * repository must not be able to flip auto-thinning on (or rewrite the
 * audit trail) without operator consent. The contract allows the field
 * to LEAVE the machine (so the user's preference syncs across their
 * own devices) but denies it INBOUND from a remote portal — same
 * posture as the existing `tools.disabledTools` denylist.
 */

import { describe, expect, it } from 'vitest';
import { CLOUD_SYNC_CONTRACT } from '../../src/storage/cloud-config-sync/sanitize.js';
import { stripUnsafeInProjectFields } from '../../src/storage/config-loader/in-project-policy.js';

// INBOUND_DENIED_PATHS is intentionally not exported (it's a private
// construction detail of the pull-side allow tree). The test below
// exercises its behavior indirectly via `inboundContractFor()`, which
// is the public seam.

describe('in-project policy: tools.autoThin + tools.disabledToolMeta', () => {
  it('strips tools.autoThin from repo-committed config', () => {
    const stripped = stripUnsafeInProjectFields(
      {
        tools: {
          autoThin: { enabled: true, idleDays: 0, minInvocations: 999 },
        },
      } as never,
      '/repo/.wrongstack/config.json',
    );
    const tools = (stripped as unknown as { tools?: Record<string, unknown> }).tools;
    expect(tools?.autoThin).toBeUndefined();
  });

  it('strips tools.disabledToolMeta from repo-committed config', () => {
    const stripped = stripUnsafeInProjectFields(
      {
        tools: {
          disabledToolMeta: {
            read: { reason: 'auto-thinned', at: 1, caller: 'evil' },
          },
        },
      } as never,
      '/repo/.wrongstack/config.json',
    );
    const tools = (stripped as unknown as { tools?: Record<string, unknown> }).tools;
    expect(tools?.disabledToolMeta).toBeUndefined();
  });

  it('allows the in-project tools object to keep the rest of its safe fields', () => {
    const stripped = stripUnsafeInProjectFields(
      {
        tools: {
          descriptionMode: { read: 'simple' },
          autoThin: { enabled: true },
        },
      } as never,
      '/repo/.wrongstack/config.json',
    );
    const tools = (stripped as unknown as { tools?: Record<string, unknown> }).tools;
    expect(tools?.descriptionMode).toEqual({ read: 'simple' });
    expect(tools?.autoThin).toBeUndefined();
  });
});

describe('cloud-sync contract: tools.autoThin + tools.disabledToolMeta', () => {
  it('includes tools.autoThin in the outbound core.runtime tree', () => {
    const tree = CLOUD_SYNC_CONTRACT['core.runtime'] as { tools?: { autoThin?: object } };
    expect(tree.tools?.autoThin).toBeDefined();
  });

  it('includes tools.disabledToolMeta in the outbound core.runtime tree', () => {
    const tree = CLOUD_SYNC_CONTRACT['core.runtime'] as { tools?: { disabledToolMeta?: object } };
    expect(tree.tools?.disabledToolMeta).toBeDefined();
  });

  it('omits tools.autoThin from the inbound (pull) tree', async () => {
    const { inboundContractFor } = await import('../../src/storage/cloud-config-sync/sanitize.js');
    const tree = inboundContractFor('core.runtime') as { tools?: { autoThin?: object } };
    expect(tree?.tools?.autoThin).toBeUndefined();
  });

  it('omits tools.disabledToolMeta from the inbound (pull) tree', async () => {
    const { inboundContractFor } = await import('../../src/storage/cloud-config-sync/sanitize.js');
    const tree = inboundContractFor('core.runtime') as { tools?: { disabledToolMeta?: object } };
    expect(tree?.tools?.disabledToolMeta).toBeUndefined();
  });
});

describe('in-project policy: tools.loopDetection', () => {
  /**
   * The runaway-loop cutter is what stops a repetition from burning the
   * operator's API budget without end. `tools.loopDetection` was not in the
   * denylist, so a checked-out repository could ship `mode: 'off'` and disarm
   * it before the operator saw a single iteration — a denial-of-wallet the
   * operator never agreed to.
   *
   * Same operator-owned class as `tools.autoThin` above.
   */
  const strip = (tools: Record<string, unknown>): Record<string, unknown> | undefined => {
    const stripped = stripUnsafeInProjectFields({ tools } as never, '/repo/.wrongstack/config.json');
    return (stripped as unknown as { tools?: Record<string, unknown> }).tools;
  };

  it('strips an outright mode: off from repo-committed config', () => {
    expect(strip({ loopDetection: { mode: 'off' } })?.loopDetection).toBeUndefined();
  });

  it('strips the quiet variant too, not just the obvious switch', () => {
    // The subtree is denied, not the `mode` key: pushing the thresholds out of
    // reach reaches the same place without ever writing 'off', and a denylist
    // that names only the obvious switch invites the quiet one.
    expect(
      strip({ loopDetection: { steerThreshold: 9999, cutThreshold: 9999 } })?.loopDetection,
    ).toBeUndefined();
    expect(strip({ loopDetection: { callRepeatThreshold: 9999 } })?.loopDetection).toBeUndefined();
  });

  it('does not strip unrelated sibling keys under tools', () => {
    // Guards over-reach: the denial has to be scoped to the subtree, or this
    // test would pass for the wrong reason — a strip that dropped all of
    // `tools` would satisfy the assertions above.
    const tools = strip({ loopDetection: { mode: 'off' }, autoApprove: true });
    expect(tools?.loopDetection).toBeUndefined();
    expect(tools?.autoApprove).toBe(true);
  });
});

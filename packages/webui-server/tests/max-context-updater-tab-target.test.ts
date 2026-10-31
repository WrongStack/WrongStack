/**
 * Every WebUI tab is its own conversation, but the context-window updater is created once per
 * engine around the leader's context. A model switch (or fallback hop) in another tab wrote that
 * tab's window into the LEADER's meta and the shared compactor, while the tab kept the window it
 * copied from the leader when it was created — and the compaction threshold prefers that copied
 * value over the provider's. A tab moved from a 1M to a 200k model kept compacting against 1M.
 * (`effectiveMaxContext` in core/execution/compaction-thresholds.ts reads that meta first.)
 */

import { describe, expect, it } from 'vitest';
import { createMaxContextUpdater } from '../src/server/max-context-updater.js';

const WINDOWS: Record<string, number> = { 'prov-a': 1_000_000, 'prov-b': 200_000 };

function setup() {
  const registry = {
    ageSeconds: async () => 0,
    refresh: async () => ({}),
    getProvider: async () => undefined,
    getModel: async (providerId: string, modelId: string) => ({
      id: modelId,
      providerId,
      capabilities: { maxContext: WINDOWS[providerId] },
    }),
    onCatalogChanged: () => () => undefined,
  };
  const compactorWindows: number[] = [];
  const events: Array<Record<string, unknown>> = [];
  const conversation = (id: string, providerId: string) => ({
    model: `model-${providerId}`,
    provider: { id: providerId, capabilities: { maxContext: WINDOWS[providerId] } } as unknown,
    meta: { effectiveMaxContext: 1_000_000 } as Record<string, unknown>,
    session: { id },
  });
  const leader = conversation('leader', 'prov-a');
  const update = createMaxContextUpdater({
    config: { context: {} } as never,
    getConfig: () => ({ context: {}, providers: {} }) as never,
    context: leader as never,
    modelsRegistry: registry as never,
    events: {
      emit: (_name: string, payload: Record<string, unknown>) => events.push(payload),
    } as never,
    logger: { warn: () => undefined, debug: () => undefined } as never,
    modelCapabilitiesRef: { current: undefined },
    autoCompactor: {
      setMaxContext: (n: number) => compactorWindows.push(n),
      setEnabled: () => undefined,
    } as never,
  });
  return { update, leader, conversation, compactorWindows, events };
}

describe('max-context updater — a tab other than the leader', () => {
  it("resolves the window into that tab's own context and leaves the leader alone", async () => {
    const h = setup();
    // A tab created from the leader inherited its resolved window, then switched to prov-b.
    const tab = h.conversation('tab-2', 'prov-a');
    const provider = { id: 'prov-b', capabilities: { maxContext: 0 } };
    tab.provider = provider;
    tab.model = 'model-prov-b';
    await h.update(provider as never, 'prov-b', undefined, tab as never);

    expect(tab.meta['effectiveMaxContext']).toBe(200_000);
    expect(provider.capabilities.maxContext).toBe(200_000);
    expect(h.leader.meta['effectiveMaxContext']).toBe(1_000_000);
    expect(h.compactorWindows).toEqual([]);
    expect(h.events).toEqual([
      expect.objectContaining({ sessionId: 'tab-2', providerId: 'prov-b', maxContext: 200_000 }),
    ]);
  });
  it('still serves the leader when the target is the leader or absent', async () => {
    const h = setup();
    const provider = { id: 'prov-b', capabilities: { maxContext: 0 } };
    h.leader.provider = provider;
    h.leader.model = 'model-prov-b';
    await h.update(provider as never, 'prov-b', undefined, h.leader as never);
    expect(h.leader.meta['effectiveMaxContext']).toBe(200_000);
    expect(h.compactorWindows).toEqual([200_000]);
  });
});

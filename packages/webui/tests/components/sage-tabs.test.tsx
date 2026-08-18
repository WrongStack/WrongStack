/**
 * SageTabs — third-lens wiring for the Vector memory tab.
 *
 * Guards the migration that moved VectorMemoryPanel from a standalone
 * in-flow panel below the tab shell into the tab bar itself: the trigger
 * must render after the two SAGE lenses, activating it must mount the real
 * panel (fetch stubbed at the status boundary), and inactive lenses stay
 * unmounted (Radix default) so hosting the panel costs nothing until the
 * tab is opened.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      ({
        'activity:memoryManager.lensesAria': 'SAGE memory lenses',
        'activity:memoryManager.loadingSage': 'Loading SAGE',
        'activity:memoryManager.loadingAudience': 'Loading audience memories',
        'activity:memoryManager.loadingVectorMemory': 'Loading vector memory',
        'activity:memoryManager.tabAllMemories': 'All memories',
        'activity:memoryManager.tabAllMemoriesHint': 'Inspect, curate, retire',
        'activity:memoryManager.tabAudience': 'Audience-scoped',
        'activity:memoryManager.tabAudienceHint': 'Guidance routed to agents',
        'activity:memoryManager.tabVectorMemory': 'Vector memory',
        'activity:memoryManager.tabVectorMemoryHint': 'Semantic embedding store',
      })[key] ?? key,
  }),
}));

vi.mock('../../src/components/MemoryManager/index.js', () => ({
  MemoryManager: () => <div>All-memories lens</div>,
}));
vi.mock('../../src/components/AudienceMemoryPanel.js', () => ({
  AudienceMemoryPanel: () => <div>Audience lens</div>,
}));

vi.stubGlobal(
  'fetch',
  vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          enabled: true,
          providerId: 'transformers',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          entries: 1,
          vectors: 1,
          providers: ['transformers'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  ),
);

import { SageTabs } from '../../src/components/MemoryManager/SageTabs.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SageTabs vector memory lens', () => {
  it('renders Vector memory as the third trigger with All memories active', async () => {
    render(<SageTabs />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.getAttribute('data-state'))).toEqual([
      'active',
      'inactive',
      'inactive',
    ]);
    // Trigger name carries the hint span — match on the label prefix.
    expect(screen.getByRole('tab', { name: /vector memory/i })).toBeTruthy();
    // Default lens mounts its (mocked) panel once the lazy import resolves.
    await screen.findByText('All-memories lens');
  });

  it('mounts the real vector panel only after the tab is activated', async () => {
    render(<SageTabs />);
    // The panel's h3 ("Vector Memory") is absent while the lens is inactive.
    expect(screen.queryByText('Vector Memory')).toBeNull();

    // Radix TabsTrigger activates on mousedown (v1.1), not on click.
    const vectorTab = screen.getByRole('tab', { name: /vector memory/i });
    fireEvent.mouseDown(vectorTab);
    fireEvent.click(vectorTab);

    // Real panel (not a mock): status strip resolves through the stubbed fetch.
    await screen.findByText('Xenova/all-MiniLM-L6-v2');
    expect(screen.getByText('Vector Memory')).toBeTruthy();
    expect(screen.getByLabelText('Query')).toBeTruthy();
    // Switching lenses unmounts the vector panel again.
    const audienceTab = screen.getByRole('tab', { name: /audience-scoped/i });
    fireEvent.mouseDown(audienceTab);
    fireEvent.click(audienceTab);
    await screen.findByText('Audience lens');
    expect(screen.queryByText('Vector Memory')).toBeNull();
  });
});

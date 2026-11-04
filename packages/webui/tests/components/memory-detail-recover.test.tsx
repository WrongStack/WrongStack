import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDetail } from '../../src/components/MemoryManager/MemoryDetail.js';
import type { SageEntry } from '../../src/types/sage.js';

const translation = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('@/i18n', () => ({ useAppTranslation: () => translation }));
vi.mock('@wrongstack/project-surfaces/lib/i18n', () => ({ useAppTranslation: () => translation }));
afterEach(cleanup);

function entry(overrides: Partial<SageEntry> = {}): SageEntry {
  return {
    id: 'mem_1',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: 'Some memory.',
    importance: 0.5,
    confidence: 0.5,
    freshness: 0.5,
    tags: [],
    anchors: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mount(memory: SageEntry, onRecover = vi.fn()) {
  render(
    <MemoryDetail
      memory={memory}
      allMemories={[memory]}
      relatedMemories={[]}
      graphEdges={[]}
      graphLoading={false}
      graphError={null}
      onClose={() => {}}
      onOpenMemory={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onRecover={onRecover}
      onTagSelect={() => {}}
      onNotice={() => {}}
    />,
  );
  return onRecover;
}

/**
 * The Deleted tab lists recoverable records; before, its detail panel only had
 * Copy / Edit (disabled) / Delete (disabled), so recovery was reachable only
 * from the file drawer.
 */
describe('MemoryDetail — recover', () => {
  it('offers Recover for a deleted record and reports its id', () => {
    const onRecover = mount(entry({ id: 'mem_gone', status: 'deleted' }));
    expect(screen.queryByRole('button', { name: /common:action\.delete/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /activity:memoryManager\.actionRecover/ }));
    expect(onRecover).toHaveBeenCalledWith('mem_gone');
  });

  it('keeps Delete and hides Recover for a live record', () => {
    mount(entry({ status: 'active' }));
    expect(screen.getByRole('button', { name: /common:action\.delete/ })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /activity:memoryManager\.actionRecover/ }),
    ).toBeNull();
  });
});

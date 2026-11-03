import { cleanup, render, screen } from '@testing-library/react';
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

function mount(memory: SageEntry) {
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
      onTagSelect={() => {}}
      onNotice={() => {}}
    />,
  );
}

// This package has no jest-dom matchers, so read the DOM directly.

/**
 * `staleReason` exists to separate two situations that look identical from the
 * status badge alone. An operator triaging a stale memory needs to know whether
 * a later passing anchor check could restore it (`verification`) or whether a
 * person deliberately retired it and automatic passes will leave it alone
 * (`manual`). Rendering a bare "stale" for both makes Restore unsafe to offer.
 */
describe('MemoryDetail — stale reason', () => {
  it('distinguishes a failed anchor check from a manual retirement', () => {
    mount(entry({ status: 'stale', staleReason: 'verification' }));
    let badge = screen.getByTestId('memory-stale-reason');
    expect(badge.getAttribute('data-stale-reason')).toBe('verification');
    expect(badge.textContent).toContain('activity:memoryManager.staleReasonVerification');

    cleanup();

    mount(entry({ status: 'stale', staleReason: 'manual' }));
    badge = screen.getByTestId('memory-stale-reason');
    expect(badge.getAttribute('data-stale-reason')).toBe('manual');
    expect(badge.textContent).toContain('activity:memoryManager.staleReasonManual');
  });

  it('labels pre-field records as unknown rather than guessing a cause', () => {
    // Records written before `staleReason` existed carry no value. Defaulting to
    // either branch would assert a cause nobody recorded.
    mount(entry({ status: 'stale' }));
    const badge = screen.getByTestId('memory-stale-reason');
    expect(badge.getAttribute('data-stale-reason')).toBe('unknown');
    expect(badge.textContent).toContain('activity:memoryManager.staleReasonUnknown');
  });

  it('renders no stale-reason badge for a non-stale memory', () => {
    // A staleReason left over on a record that was later revived must not keep
    // claiming the memory is demoted.
    mount(entry({ status: 'active', staleReason: 'verification' }));
    expect(screen.queryByTestId('memory-stale-reason')).toBeNull();
  });
});

/**
 * `injectionCount` / `useCount` / `lastUsedAt` are the corpus's only quality
 * signal. Hygiene keys retirement candidates on exactly these numbers, so the
 * detail view has to show them or the review decision has no evidence behind it.
 */
describe('MemoryDetail — usefulness signals', () => {
  it('shows injection and use counts for a memory that reached context', () => {
    mount(entry({ injectionCount: 12, useCount: 3, lastUsedAt: '2026-02-02T00:00:00.000Z' }));
    const panel = screen.getByTestId('memory-usefulness');
    expect(panel.getAttribute('data-injection-count')).toBe('12');
    expect(panel.getAttribute('data-use-count')).toBe('3');
    expect(panel.textContent).toContain('activity:memoryManager.usefulnessInjected');
    expect(panel.textContent).toContain('activity:memoryManager.usefulnessUsed');
    // 3 of 12 — the ratio is what makes "injected but never used" visible.
    expect(panel.textContent).toContain('3 / 12 (25%)');
  });

  it('renders a zero-count memory as never injected rather than 0 / 0', () => {
    mount(entry({ injectionCount: 0, useCount: 0 }));
    expect(screen.getByTestId('memory-usefulness').getAttribute('data-injection-count')).toBe('0');
    expect(screen.getByText('activity:memoryManager.usefulnessNeverInjected')).not.toBeNull();
    // No misleading NaN% ratio anywhere in the panel.
    expect(screen.getByTestId('memory-usefulness').textContent).not.toContain('NaN');
  });

  it('omits the panel when the backend reported no usefulness fields at all', () => {
    mount(entry());
    expect(screen.queryByTestId('memory-usefulness')).toBeNull();
  });
});

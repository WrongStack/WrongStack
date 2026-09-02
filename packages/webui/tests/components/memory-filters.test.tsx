import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SageStats } from '../../src/types.js';
import { MemoryFilters } from '../../src/components/MemoryManager/MemoryFilters.js';

const baseStats: SageStats = {
  total: 3,
  byStatus: { active: 3 },
  byKind: { fact: 1, decision: 1, convention: 1 },
  edges: 0,
};

const threeTags: Array<[string, number]> = [
  ['webui', 3],
  ['architecture', 2],
  ['testing', 1],
];

function renderFilters(overrides: Partial<React.ComponentProps<typeof MemoryFilters>> = {}) {
  const onSearchChange = vi.fn();
  const onStatusFilterChange = vi.fn();
  const onKindFilterChange = vi.fn();
  const onToggleAudienceOnly = vi.fn();
  const onTagFilterChange = vi.fn();
  const onClearFilters = vi.fn();
  const utils = render(
    <MemoryFilters
      searchQuery=""
      statusFilter="all"
      kindFilter="all"
      audienceOnly={false}
      tagFilter={null}
      hasFilters={false}
      allTags={threeTags}
      stats={baseStats}
      onSearchChange={onSearchChange}
      onStatusFilterChange={onStatusFilterChange}
      onKindFilterChange={onKindFilterChange}
      onToggleAudienceOnly={onToggleAudienceOnly}
      onTagFilterChange={onTagFilterChange}
      onClearFilters={onClearFilters}
      {...overrides}
    />,
  );
  return {
    ...utils,
    onSearchChange,
    onStatusFilterChange,
    onKindFilterChange,
    onToggleAudienceOnly,
    onTagFilterChange,
    onClearFilters,
  };
}

// The toggle is the unique button with aria-controls pointing at the
// chip-row fieldset — that's its stable identifier.
function getToggle(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: (_accessibleName, element) =>
      element.getAttribute('aria-controls') === 'memory-tags-panel',
  }) as HTMLButtonElement;
}

function expectExpanded(toggle: HTMLButtonElement, expanded: boolean) {
  expect(toggle.getAttribute('aria-expanded')).toBe(expanded ? 'true' : 'false');
  const fieldset = document.getElementById('memory-tags-panel');
  if (expanded) {
    expect(fieldset).not.toBeNull();
  } else {
    expect(fieldset).toBeNull();
  }
}

describe('MemoryFilters · tag-chip collapse', () => {
  it('collapses the tag-chip row by default when no tag is active', () => {
    renderFilters();

    const toggle = getToggle();
    expectExpanded(toggle, false);
    // Individual tag chips must not be reachable as buttons yet.
    expect(screen.queryByRole('button', { name: /webui/i })).toBeNull();
  });

  it('expands the row when the toggle is clicked, then collapses it on a second click', () => {
    renderFilters();

    const toggle = getToggle();
    expectExpanded(toggle, false);

    // First click — expand.
    fireEvent.click(toggle);
    expectExpanded(toggle, true);
    // All three tags should now be reachable as buttons.
    expect(screen.getByRole('button', { name: /webui/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /architecture/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /testing/i })).toBeTruthy();

    // Second click — collapse again.
    fireEvent.click(getToggle());
    expectExpanded(getToggle(), false);
    expect(screen.queryByRole('button', { name: /webui/i })).toBeNull();
  });

  it('auto-expands the row when an active tag filter is passed in', () => {
    renderFilters({ tagFilter: 'webui' });

    // The user came in with a tag already filtered — show them the chip so
    // they can see *and* untoggle it without an extra click.
    const toggle = getToggle();
    expectExpanded(toggle, true);
    // While a tag is active the toggle is forced open *and* disabled, so the
    // user has exactly one way to collapse the row: click the active chip.
    expect(toggle.hasAttribute('disabled')).toBe(true);

    // Stable accessible name: the active-tag badge lives OUTSIDE the button,
    // so the toggle's name is still just "Tags 3" — independent of which
    // tag is active. Screen readers announce the badge separately.
    expect(toggle.textContent).toBe('Tags3');
    // The badge is rendered as a labelled <span> sibling to the toggle.
    const badge = screen.getByLabelText('Active tag filter: webui');
    expect(badge.tagName).toBe('SPAN');
    expect(badge.textContent).toBe('webui');

    // The active tag chip is rendered with aria-pressed="true".
    const webuiChip = screen.getByRole('button', { name: /webui/i });
    expect(webuiChip.getAttribute('aria-pressed')).toBe('true');

    // Clicking the (disabled) toggle is a no-op — the row stays open and the
    // chip stays in its pressed state.
    fireEvent.click(toggle);
    expectExpanded(getToggle(), true);
    expect(screen.getByRole('button', { name: /webui/i }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('routes chip clicks through onTagFilterChange', () => {
    const { onTagFilterChange } = renderFilters();

    // Expand first.
    fireEvent.click(getToggle());
    fireEvent.click(screen.getByRole('button', { name: /architecture/i }));

    expect(onTagFilterChange).toHaveBeenCalledTimes(1);
    expect(onTagFilterChange).toHaveBeenCalledWith('architecture');
  });

  it('keeps the toggle accessible name stable across different active tags', () => {
    // The a11y invariant: the toggle's accessible name must not change when
    // which tag is active changes. The active-tag badge lives in a sibling
    // element and is announced separately by screen readers.
    const { rerender } = renderFilters({ tagFilter: null });
    const collapsedName = getToggle().textContent;

    // Switch to a different tag — same stable name expected.
    rerender(
      <MemoryFilters
        searchQuery=""
        statusFilter="all"
        kindFilter="all"
        audienceOnly={false}
        tagFilter="webui"
        hasFilters
        allTags={threeTags}
        stats={baseStats}
        onSearchChange={vi.fn()}
        onStatusFilterChange={vi.fn()}
        onKindFilterChange={vi.fn()}
        onToggleAudienceOnly={vi.fn()}
        onTagFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );
    const activeName = getToggle().textContent;

    rerender(
      <MemoryFilters
        searchQuery=""
        statusFilter="all"
        kindFilter="all"
        audienceOnly={false}
        tagFilter="architecture"
        hasFilters
        allTags={threeTags}
        stats={baseStats}
        onSearchChange={vi.fn()}
        onStatusFilterChange={vi.fn()}
        onKindFilterChange={vi.fn()}
        onToggleAudienceOnly={vi.fn()}
        onTagFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );
    const otherActiveName = getToggle().textContent;

    expect(activeName).toBe(collapsedName);
    expect(otherActiveName).toBe(collapsedName);
  });
});

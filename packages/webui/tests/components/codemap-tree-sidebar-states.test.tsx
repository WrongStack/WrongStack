import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
// The sidebar lives in the shared package and translates with the app's i18next instance.
import '../../src/i18n';
import { CodeMapTreeSidebar } from '../../src/components/CodeMapTreeSidebar.js';
import type { CodeMapGraphResponse } from '../../src/components/codemap-model.js';

const emptyVirtualizer = {
  getTotalSize: () => 0,
  getVirtualItems: () => [],
  measureElement: () => undefined,
};

const emptyGraph: CodeMapGraphResponse = { nodes: [], edges: [] };

const packageGraph: CodeMapGraphResponse = {
  nodes: [
    {
      id: 'pkg:core',
      label: '@wrongstack/core',
      kind: 'package',
      package: '@wrongstack/core',
      symbolCount: 120,
      fileCount: 30,
    },
  ],
  edges: [],
};

function renderSidebar(
  overrides: Partial<Parameters<typeof CodeMapTreeSidebar>[0]>,
): ReturnType<typeof render> {
  const props = {
    rootGraph: packageGraph,
    loading: false,
    error: null,
    onRetry: () => undefined,
    search: '',
    searchInput: '',
    searchResults: [],
    virtualizeSearch: false,
    searchVirtualizer: emptyVirtualizer,
    treeScrollRef: { current: null },
    selectedId: null,
    expandedPackages: new Set<string>(),
    expandedDirectories: new Set<string>(),
    expandedFiles: new Set<string>(),
    loadingBranches: new Set<string>(),
    activeFileNorms: new Set<string>(),
    activeSymbolIds: new Set<string>(),
    revealAllKeys: new Set<string>(),
    packageGraph: () => undefined,
    graphForFile: () => undefined,
    navigate: () => undefined,
    togglePackage: () => undefined,
    toggleDirectory: () => undefined,
    toggleFile: () => undefined,
    revealAllTree: () => undefined,
    selectFileFromTree: () => undefined,
    selectSymbolFromTree: () => undefined,
    selectSearchResult: () => undefined,
    handleOpenNode: () => undefined,
    onSearchInputChange: () => undefined,
    onSearchChange: () => undefined,
    ...overrides,
  };
  return render(<CodeMapTreeSidebar {...props} />);
}

describe('CodeMapTreeSidebar state branches', () => {
  it('renders skeleton rows while the root graph loads and nothing is cached', () => {
    renderSidebar({ rootGraph: emptyGraph, loading: true });
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Mapping relationships');
  });

  it('renders a friendly error with a focusable retry button on load failure', () => {
    const onRetry = vi.fn();
    renderSidebar({
      rootGraph: emptyGraph,
      error: 'CodeMap graph unavailable — start the WebUI server to load it.',
      onRetry,
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The code tree could not load.');
    const retry = screen.getByRole('button', { name: /retry/i });
    expect(retry).toBeTruthy();
    expect(retry.getAttribute('tabindex')).not.toBe('-1');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders an explicit empty state when the index has no nodes', () => {
    renderSidebar({ rootGraph: emptyGraph });
    expect(screen.getByText('No indexed nodes at this level.')).toBeTruthy();
  });

  it('renders package rows on success', () => {
    renderSidebar({});
    expect(screen.getByText('@wrongstack/core')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

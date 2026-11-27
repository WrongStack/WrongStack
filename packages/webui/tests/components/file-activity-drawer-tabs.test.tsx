import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { FileActivityDrawer } from '../../src/components/FileActivityDrawer.js';

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    getGitDiff: () => undefined,
    on: () => () => undefined,
    send: () => undefined,
    supportsCapability: () => false,
  }),
}));

vi.mock('@/stores', () => ({
  useConfigStore: (selector: (state: { wsUrl: string }) => unknown) =>
    selector({ wsUrl: 'ws://test' }),
  useCodemapActivityStore: (
    selector: (state: {
      history: Map<string, unknown>;
      activeOperations: Map<string, unknown>;
    }) => unknown,
  ) => selector({ history: new Map(), activeOperations: new Map() }),
  useKanbanStore: (selector: (state: { activeBoard: undefined }) => unknown) =>
    selector({ activeBoard: undefined }),
  useSddBoardStore: (selector: (state: { snapshot: undefined }) => unknown) =>
    selector({ snapshot: undefined }),
}));

afterEach(cleanup);

describe('FileActivityDrawer tab state', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('exposes the selected view with aria-pressed inside a labelled group', () => {
    render(
      <FileActivityDrawer
        file={{
          path: 'src/example.ts',
          content: 'export const value = 1;\n',
          dirty: false,
          savedContent: 'export const value = 1;\n',
        }}
      />,
    );

    const group = screen.getByRole('group', { name: 'File activity' });
    const overview = screen.getByRole('button', { name: 'Overview' });
    expect(group.contains(overview)).toBe(true);
    expect(screen.getByRole('button', { name: 'Overview', pressed: true })).toBe(overview);

    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    expect(screen.getByRole('button', { name: 'Logs', pressed: true })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Overview', pressed: true })).toBeNull();
  });
});

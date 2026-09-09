import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { findToolViewControl } from '../src/components/history/copy-geometry.js';
import { buildCopyRegistry } from '../src/components/history/copy-registry.js';
import { ToolCard } from '../src/components/history/tool-card.js';
import { viewControlColumns } from '../src/components/history/tool-card-geometry.js';
import { ToolGroup, type ToolGroupData } from '../src/components/history/tool-group.js';
import { Text } from '../src/ink.js';
import { stripAnsi } from '../src/terminal-width.js';

const UP = '▲';
const DOWN = '▼';

/**
 * The view-mode triangles are rendered by the card components and hit-tested
 * by `copy-registry`, which used to hard-code columns 2 and 5 while the
 * glyphs render at 3 and 6 — every click on a triangle missed by one cell and
 * silently did nothing. These assert the rendered column IS the hit column,
 * for both header shapes, so the two can never drift apart again.
 */
describe('tool view-mode control geometry', () => {
  const headerOf = (frame: string | undefined): string =>
    stripAnsi(frame ?? '')
      .split('\n')
      .find((line) => line.includes(UP)) ?? '';

  it('ToolCard renders the controls at the hit-tested columns', () => {
    const view = render(
      React.createElement(
        ToolCard,
        {
          glyph: 'X',
          color: 'blue',
          title: 'read',
          ok: true,
          termWidth: 80,
          hasBody: true,
          viewMode: 'normal' as const,
        },
        React.createElement(Text, null, 'result'),
      ),
    );
    const header = headerOf(view.lastFrame());
    view.unmount();
    const { lessCol, moreCol } = viewControlColumns();
    expect(header.indexOf(UP)).toBe(lessCol);
    expect(header.indexOf(DOWN)).toBe(moreCol);
  });

  it('a body-less ToolCard keeps the same control columns', () => {
    const view = render(
      React.createElement(ToolCard, {
        glyph: 'X',
        color: 'blue',
        title: 'read',
        ok: true,
        termWidth: 80,
        hasBody: false,
        viewMode: 'minimal' as const,
      }),
    );
    const header = headerOf(view.lastFrame());
    view.unmount();
    const { lessCol, moreCol } = viewControlColumns();
    expect(header.indexOf(UP)).toBe(lessCol);
    expect(header.indexOf(DOWN)).toBe(moreCol);
  });

  for (const viewMode of ['minimal', 'normal', 'full'] as const) {
    it(`ToolGroup (${viewMode}) renders the controls at the hit-tested columns`, () => {
      const data: ToolGroupData = {
        name: 'read',
        entries: [
          { id: 1, kind: 'tool', name: 'read', durationMs: 1, ok: true, output: 'a' },
          { id: 2, kind: 'tool', name: 'read', durationMs: 2, ok: true, output: 'b' },
        ],
        totalDurationMs: 3,
        okCount: 2,
        failCount: 0,
      };
      const view = render(React.createElement(ToolGroup, { data, termWidth: 80, viewMode }));
      const header = headerOf(view.lastFrame());
      view.unmount();
      const { lessCol, moreCol } = viewControlColumns();
      expect(header.indexOf(UP)).toBe(lessCol);
      expect(header.indexOf(DOWN)).toBe(moreCol);
    });
  }

  it('the registry publishes those columns and they resolve to less/more', () => {
    const registry = buildCopyRegistry({
      renderGroups: [
        {
          type: 'single',
          entry: { id: 4, kind: 'tool', name: 'read', durationMs: 1, ok: true, output: 'x' },
        },
      ],
      heightCache: { getHeight: () => 3, size: 1 } as never,
      scrolled: true,
      clip: 0,
      tailRows: 0,
      viewportRows: 20,
      iconCol: 80,
      liveToolVisible: false,
      viewModeForEntry: () => 'normal',
    });
    const hit = registry.hits[0];
    expect(hit).toBeDefined();
    const { lessCol, moreCol } = viewControlColumns();
    expect(hit?.lessCol).toBe(lessCol);
    expect(hit?.moreCol).toBe(moreCol);
    expect(findToolViewControl(registry.hits, hit!.startRow, lessCol)?.delta).toBe(-1);
    expect(findToolViewControl(registry.hits, hit!.startRow, moreCol)?.delta).toBe(1);
  });
});

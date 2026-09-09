import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { type CopyHit, findToolViewControl } from '../src/components/history/copy-geometry.js';
import { Entry } from '../src/components/history/entry.js';
import { viewControlColumns } from '../src/components/history/tool-card-geometry.js';
import { shiftToolResultViewMode } from '../src/tool-result-view-mode.js';
import { createTestState } from './helpers/create-test-state.js';

const tool = {
  id: 7,
  kind: 'tool' as const,
  name: 'extension_tool',
  durationMs: 12,
  ok: true,
  output: 'first line\nsecond line\nthird line',
  copyOutput: 'first line\nsecond line\nthird line\ncanonical tail',
};

describe('tool result view modes', () => {
  it('renders header-only minimal, semantic normal, and canonical bounded full', () => {
    const minimal = render(<Entry entry={tool} termWidth={90} toolResultViewMode="minimal" />);
    expect(minimal.lastFrame()).toContain('extension_tool');
    expect(minimal.lastFrame()).toContain('▲  ▼');
    // Collapsed cards close the rail (`└─ `) instead of opening a
    // continuation one (`╭─ `) — b315ce08c inverted BOTH assertions into
    // `not.toMatch`, which no frame can satisfy: the header always starts
    // with one lead or the other.
    expect(minimal.lastFrame()).toMatch(/^└─/u);
    expect(minimal.lastFrame()).not.toContain('first line');
    minimal.unmount();

    const normal = render(<Entry entry={tool} termWidth={90} toolResultViewMode="normal" />);
    expect(normal.lastFrame()).toMatch(/^╭─/u);
    expect(normal.lastFrame()).toContain('first line second line third line');
    expect(normal.lastFrame()).not.toContain('canonical tail');
    normal.unmount();

    const full = render(<Entry entry={tool} termWidth={90} toolResultViewMode="full" />);
    expect(full.lastFrame()).toContain('first line');
    expect(full.lastFrame()).toContain('canonical tail');
    full.unmount();
  });

  it('caps full view at 40 lines', () => {
    const output = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join('\n');
    const view = render(
      <Entry
        entry={{ ...tool, output, copyOutput: output }}
        termWidth={90}
        toolResultViewMode="full"
      />,
    );
    expect(view.lastFrame()).toContain('line-40');
    expect(view.lastFrame()).not.toContain('line-41');
    expect(view.lastFrame()).toContain('full view limited to 40 lines / 16 KiB');
    view.unmount();
  });

  it('maps the spaced tool-header cells to less/more actions', () => {
    const { lessCol, moreCol } = viewControlColumns();
    const hit: CopyHit = {
      entryId: 7,
      startRow: 3,
      endRow: 4,
      iconCol: 80,
      toolEntryIds: [7],
      toolViewMode: 'normal',
      lessCol,
      moreCol,
    };
    expect(findToolViewControl([hit], 3, lessCol)?.delta).toBe(-1);
    expect(findToolViewControl([hit], 3, moreCol)?.delta).toBe(1);
    // One cell of slack to the right of each glyph — a one-cell target on a
    // one-row header is not reliably clickable.
    expect(findToolViewControl([hit], 3, lessCol + 1)?.delta).toBe(-1);
    expect(findToolViewControl([hit], 3, moreCol + 1)?.delta).toBe(1);
    // The dead cell between the controls fires neither.
    expect(findToolViewControl([hit], 3, moreCol - 1)).toBeNull();
    // Cells left of the controls belong to the card lead.
    expect(findToolViewControl([hit], 3, lessCol - 1)).toBeNull();
    expect(findToolViewControl([hit], 4, moreCol)).toBeNull();
  });

  it('keeps overrides independent and clears them on a global change', () => {
    let state = createTestState();
    state = reducer(state, { type: 'toolResultViewSet', entryIds: [7], mode: 'full' });
    state = reducer(state, { type: 'toolResultViewSet', entryIds: [8], mode: 'minimal' });
    expect(state.toolResultViewOverrides.get(7)).toBe('full');
    expect(state.toolResultViewOverrides.get(8)).toBe('minimal');
    state = {
      ...state,
      settingsPicker: { ...state.settingsPicker, field: 62, toolResultViewMode: 'normal' },
    };
    state = reducer(state, { type: 'settingsValueChange', delta: 1 });
    expect(state.settingsPicker.toolResultViewMode).toBe('full');
    expect(state.toolResultViewOverrides.size).toBe(0);
  });

  it('clamps controls at the ends', () => {
    expect(shiftToolResultViewMode('minimal', -1)).toBe('minimal');
    expect(shiftToolResultViewMode('normal', -1)).toBe('minimal');
    expect(shiftToolResultViewMode('normal', 1)).toBe('full');
    expect(shiftToolResultViewMode('full', 1)).toBe('full');
  });
});

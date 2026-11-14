import { afterEach, describe, expect, it } from 'vitest';
import { commandListWindow } from '../src/components/command-list-window.js';
import { FilePicker } from '../src/components/file-picker.js';
import { HelpPanel } from '../src/components/help-panel.js';
import { SlashMenu } from '../src/components/slash-menu.js';
import { displayWidth } from '../src/terminal-width.js';
import { getActiveThemeName, setActiveTheme } from '../src/theme.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const entries = Array.from({ length: 40 }, (_, index) => ({
  name: `command-${String(index).padStart(2, '0')}`,
  category: index < 20 ? ('Run' as const) : ('Session' as const),
  description: 'Inspect the current session and its active tasks',
  help: 'Inspect session state.\nUse the command to review active tasks and their progress.',
}));
const commands = entries.map((entry) => ({ ...entry, name: `/${entry.name}`, isBuiltin: true }));
const files = entries.map(
  (entry) => `src/very-long-directory/another-directory/文件/${entry.name}.tsx`,
);
const originalTheme = getActiveThemeName();
afterEach(() => setActiveTheme(originalTheme));

function expectFits(frame: string, columns: number, rows: number): void {
  const lines = frame.trimEnd().split('\n');
  expect(lines.length).toBeLessThanOrEqual(rows);
  expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(columns);
}

describe('command category windows', () => {
  it('keeps every focus visible within every row budget, including category boundaries', () => {
    for (let capacity = 1; capacity <= 15; capacity++) {
      for (let focus = 0; focus < entries.length; focus++) {
        const window = commandListWindow(entries, focus, capacity);
        expect(window.rows.length).toBeLessThanOrEqual(capacity);
        expect(window.rows.some((row) => row.type === 'item' && row.index === focus)).toBe(true);
      }
    }
  });
  it('clamps stale selection and handles an empty list', () => {
    expect(commandListWindow([], 20, 4).rows).toEqual([]);
    for (const selected of [-4, 999]) {
      const window = commandListWindow(entries, selected, 3);
      expect(window.rows.some((row) => row.type === 'item' && row.index === window.focus)).toBe(
        true,
      );
    }
  });
});

it.each([
  [110, 8],
  [52, 12],
])('uses list-only help when details cannot fit at %ix%i', async (columns, maxRows) => {
  const view = renderRealTty(
    <HelpPanel entries={entries} filter="" selected={23} maxRows={maxRows} />,
    { columns, rows: 30 },
  );
  try {
    await settle();
    expectFits(view.lastFrame(), columns, maxRows);
    expect(view.lastFrame()).toContain('› /command-23');
    expect(view.lastFrame()).not.toContain('Usage:');
  } finally {
    view.unmount();
  }
});

describe.each([
  [110, 22],
  [76, 18],
  [52, 22],
  [40, 8],
  [32, 8],
  [32, 7],
  [32, 6],
  [32, 4],
  [32, 3],
  [32, 2],
  [32, 1],
])('discovery at %i columns with %i rows', (columns, maxRows) => {
  it.each(['help', 'commands', 'files'] as const)(
    '%s preserves focus and close controls',
    async (kind) => {
      const props = { columns, maxRows, selected: 23 };
      const element =
        kind === 'help' ? (
          <HelpPanel {...props} entries={entries} filter="" />
        ) : kind === 'commands' ? (
          <SlashMenu {...props} query="" matches={commands} />
        ) : (
          <FilePicker {...props} query="" matches={files} />
        );
      // A wide physical terminal with a narrower main column catches sidebar overlap.
      const view = renderRealTty(element, { columns: 140, rows: 40 });
      try {
        await settle();
        const frame = view.lastFrame();
        expectFits(frame, columns, maxRows);
        expect(frame).toContain('command-23');
        expect(frame).toContain('› ');
        expect(frame).toContain('Esc');
        if (kind === 'files') expect(frame).toContain('command-23.tsx');
      } finally {
        view.unmount();
      }
    },
  );
  it('keeps empty states and recovery controls inside the frame', async () => {
    const view = renderRealTty(
      <HelpPanel
        entries={entries}
        filter="not-found"
        selected={0}
        columns={columns}
        maxRows={maxRows}
      />,
      { columns: 140, rows: 40 },
    );
    try {
      await settle();
      expectFits(view.lastFrame(), columns, maxRows);
      expect(view.lastFrame()).toContain('No commands match');
      expect(view.lastFrame()).toContain('Esc');
    } finally {
      view.unmount();
    }
  });
});

describe.each(['help', 'commands', 'files'] as const)('tiny %s viewport', (kind) => {
  it('uses the second row for actionable controls and gives focus the full first row', async () => {
    const props = { columns: 32, maxRows: 2, selected: 0 };
    const name = 'very-long-command-name';
    const element =
      kind === 'help' ? (
        <HelpPanel
          {...props}
          entries={[{ ...entries[0], name, category: 'Run', description: 'Inspect session' }]}
          filter=""
        />
      ) : kind === 'commands' ? (
        <SlashMenu
          {...props}
          matches={[
            {
              ...commands[0],
              name: `/${name}`,
              category: 'Run',
              description: 'Inspect session',
              isBuiltin: true,
            },
          ]}
          query=""
        />
      ) : (
        <FilePicker {...props} matches={[`src/${name}.tsx`]} query="" />
      );
    const view = renderRealTty(element, { columns: 80, rows: 24 });
    try {
      await settle();
      const frame = view.lastFrame();
      expectFits(frame, 32, 2);
      expect(frame.split('\n')[0]).toContain(kind === 'files' ? `${name}.tsx` : `/${name}`);
      expect(frame.split('\n')[1]).toContain('1/1');
      expect(frame.split('\n')[1]).toContain('Esc');
      if (kind !== 'help')
        expect(frame.split('\n')[1]).toContain(kind === 'files' ? 'Enter attach' : 'Enter run');
      else expect(frame).not.toContain('Enter');
    } finally {
      view.unmount();
    }
  });

  it.each([0, 3, 8, 16])(
    'respects a %i-column main pane even on a tall terminal',
    async (columns) => {
      const props = { columns, maxRows: 8, selected: 23 };
      const element =
        kind === 'help' ? (
          <HelpPanel {...props} entries={entries} filter="" />
        ) : kind === 'commands' ? (
          <SlashMenu {...props} matches={commands} query="" />
        ) : (
          <FilePicker {...props} matches={files} query="" />
        );
      const view = renderRealTty(element, { columns: 80, rows: 24 });
      try {
        await settle();
        if (columns === 0) expect(view.lastFrame().trim()).toBe('');
        else {
          expectFits(view.lastFrame(), columns, 8);
          expect(view.lastFrame()).toContain('Esc');
        }
      } finally {
        view.unmount();
      }
    },
  );
  it('keeps multiline Unicode content and terminal escapes inside three rows', async () => {
    const props = { columns: 32, maxRows: 3, selected: 0 };
    const name = '文件-e\u0301-👩‍💻';
    const description = 'Inspect\ncurrent\tsession\u001b[2J';
    const element =
      kind === 'help' ? (
        <HelpPanel
          {...props}
          entries={[{ ...entries[0], name, description, category: 'Run' }]}
          filter=""
        />
      ) : kind === 'commands' ? (
        <SlashMenu
          {...props}
          matches={[
            { ...commands[0], name: `/${name}`, description, category: 'Run', isBuiltin: true },
          ]}
          query=""
        />
      ) : (
        <FilePicker {...props} matches={[`src/${name}.tsx`]} query={description} />
      );
    const view = renderRealTty(element, { columns: 80, rows: 24 });
    try {
      await settle();
      const frame = view.lastFrame();
      expectFits(frame, 32, 3);
      expect(frame).toContain(name);
      expect(frame).toContain('Inspect current  session');
      expect(frame).toContain('1/1');
      expect(frame).toContain('Esc');
      expect(frame).not.toContain('\u001b');
    } finally {
      view.unmount();
    }
  });

  it.each([0, 1])('handles empty results with a %i-row budget', async (maxRows) => {
    const props = { maxRows, columns: 32, selected: 0 };
    const element =
      kind === 'help' ? (
        <HelpPanel {...props} entries={[]} filter="" />
      ) : kind === 'commands' ? (
        <SlashMenu {...props} matches={[]} query="" />
      ) : (
        <FilePicker {...props} matches={[]} query="" />
      );
    const view = renderRealTty(element, { columns: 80, rows: 24 });
    try {
      await settle();
      const frame = view.lastFrame();
      if (maxRows === 0) expect(frame.trim()).toBe('');
      else {
        expectFits(frame, 32, maxRows);
        expect(frame).toContain('match');
        expect(frame).toContain('Esc');
      }
    } finally {
      view.unmount();
    }
  });

  it('preserves focus while shrinking to one row and expanding again', async () => {
    const element = (maxRows: number) => {
      const props = { maxRows, columns: 40, selected: 23 };
      return kind === 'help' ? (
        <HelpPanel {...props} entries={entries} filter="" />
      ) : kind === 'commands' ? (
        <SlashMenu {...props} matches={commands} query="" />
      ) : (
        <FilePicker {...props} matches={files} query="" />
      );
    };
    const view = renderRealTty(element(18), { columns: 80, rows: 30 });
    try {
      await settle();
      for (const budget of [1, 3, 18]) {
        view.rerender(element(budget));
        await settle();
        expectFits(view.lastFrame(), 40, budget);
        expect(view.lastFrame()).toContain('command-23');
        expect(view.lastFrame()).toContain('Esc');
      }
      for (const [columns, rows] of [
        [16, 2],
        [3, 1],
        [0, 0],
        [40, 30],
      ] as const) {
        view.resize(columns, rows);
        await settle();
        if (columns === 0) expect(view.lastFrame().trim()).toBe('');
        else {
          expectFits(view.lastFrame(), columns, Math.min(18, rows));
          expect(view.lastFrame()).toContain('Esc');
          if (columns === 40) expect(view.lastFrame()).toContain('command-23');
        }
      }
    } finally {
      view.unmount();
    }
  });
});

it.each([32, 52])(
  'keeps Esc visible beside a long multiline help hint at %i columns',
  async (columns) => {
    const view = renderRealTty(
      <HelpPanel
        entries={entries}
        filter=""
        selected={23}
        columns={columns}
        maxRows={8}
        hint={`Notice: 文件\n${'long status message '.repeat(20)}`}
      />,
      { columns: 80, rows: 24 },
    );
    try {
      await settle();
      const frame = view.lastFrame();
      expectFits(frame, columns, 8);
      expect(frame).toContain('Notice:');
      expect(frame).toContain('Esc close');
      expect(frame).toContain('› /command-23');
    } finally {
      view.unmount();
    }
  },
);

it.each([110, 52])(
  'scrolls wrapped documentation to its final visual line at %i columns',
  async (columns) => {
    const entry = {
      ...entries[0],
      name: 'inspect',
      category: 'Run',
      description: 'Inspect session',
      help: `${'Long documentation with Unicode 文件 and many useful details. '.repeat(35)} END-OF-HELP`,
    };
    const view = renderRealTty(
      <HelpPanel entries={[entry]} filter="" selected={0} maxRows={22} />,
      { columns, rows: 30 },
    );
    try {
      await settle();
      expect(view.lastFrame()).toContain('Long documentation');
      expect(view.lastFrame()).not.toContain('END-OF-HELP');
      view.rerender(
        <HelpPanel entries={[entry]} filter="" selected={0} maxRows={22} detailScroll={9999} />,
      );
      await settle();
      expect(view.lastFrame()).toContain('END-OF-HELP');
      expectFits(view.lastFrame(), columns, 22);
    } finally {
      view.unmount();
    }
  },
);

it('reflows open help on live resize and reacts to theme changes without losing selection', async () => {
  const view = renderRealTty(<HelpPanel entries={entries} filter="" selected={23} />, {
    columns: 110,
    rows: 30,
  });
  try {
    await settle();
    expect(view.lastFrame()).toContain('Usage: /command-23');
    view.resize(40, 12);
    await settle();
    expectFits(view.lastFrame(), 40, 8);
    expect(view.lastFrame()).toContain('› /command-23');
    setActiveTheme('tokyo-night');
    await settle();
    expectFits(view.lastFrame(), 40, 8);
    expect(view.lastFrame()).toContain('› /command-23');
    view.resize(110, 30);
    await settle();
    expect(view.lastFrame()).toContain('Usage: /command-23');
  } finally {
    view.unmount();
  }
});

import { useState } from 'react';
import type React from 'react';
import { F_KEY_PANEL_ENTRIES } from '../f-key-panels.js';
import { Box, Text, useInput } from '../ink.js';
import { theme } from '../theme.js';
import { getToolVisual } from '../tool-glyph.js';
import { panelWindow, truncatePanelText, useMonitorSize } from './monitor-shell.js';

export interface HelpEntry {
  /** Key chord or command, e.g. `Ctrl+F` or `/model`. */
  keys: string;
  /** What it does. */
  desc: string;
}

interface HelpSection {
  title: string;
  entries: HelpEntry[];
}

/**
 * One renderable row of the flattened cheat sheet. Sections become title
 * rows and entries become key/description rows; the Tool Colors section is
 * zipped into two-column `pair` rows so the whole sheet is a flat list the
 * scroll window can slice row-exactly.
 */
type HelpRow =
  | { kind: 'section'; title: string }
  | { kind: 'entry'; keys: string; desc: string }
  | { kind: 'pair'; left: HelpEntry; right: HelpEntry | undefined };

/**
 * Static cheat-sheet content: keybindings + common slash commands, grouped by
 * area. Pure data (no JSX) so the exact set of entries is unit-testable and the
 * overlay renders identically everywhere.
 */
export function helpSections(): HelpSection[] {
  const nav: HelpEntry[] = [];
  nav.push(
    { keys: '↑/↓', desc: 'previous / next input (empty prompt)' },
    { keys: 'Shift+Tab', desc: 'focus sidebar for scroll (↑/↓), Esc to unfocus' },
    { keys: '?', desc: 'open this help (empty prompt)' },
  );

  return [
    { title: 'Navigation', entries: nav },
    {
      title: 'Monitors',
      entries: [
        ...F_KEY_PANEL_ENTRIES.map((entry) => ({
          keys: entry.helpKeys,
          desc: entry.helpDescription,
        })),
        { keys: 'Esc', desc: 'close the open monitor / overlay' },
      ],
    },
    {
      title: 'Editing',
      entries: [
        { keys: 'Enter', desc: 'send (queues while the agent is busy)' },
        { keys: 'Esc Esc', desc: 'clear the input buffer' },
        { keys: 'Ctrl+←/→', desc: 'word navigation (terminal-dependent)' },
        { keys: 'Ctrl+Backspace', desc: 'delete previous word/chip' },
        { keys: 'Ctrl+S or /settings', desc: 'settings (Ctrl+S may be reserved)' },
        { keys: 'Ctrl+V', desc: 'paste text (may be host paste)' },
        { keys: 'Alt+V', desc: 'paste image (terminal-dependent)' },
        { keys: 'Ctrl+C', desc: 'interrupt the run · twice to exit' },
      ],
    },
    {
      title: 'Commands',
      entries: [
        { keys: '/project', desc: 'switch projects (also F1)' },
        { keys: '/help', desc: 'list all slash commands' },
        { keys: '/model', desc: 'switch the active model' },
        { keys: '/fleet', desc: 'multi-agent fleet controls' },
        { keys: '/goal', desc: 'set an autonomous goal' },
        { keys: '/autonomy', desc: 'autonomy mode (eternal / off)' },
        { keys: '/settings', desc: 'settings picker (also: /settings <chord> <value> · /settings reset <chord>)' },
        { keys: '/settings-get', desc: 'show setting value(s) without opening picker' },
        { keys: '/clear', desc: 'clear the conversation' },
      ],
    },
    {
      // Surface user-facing knobs that don't have a key chord or slash
      // command of their own — the only way to change them is through the
      // settings picker. Keeping the descriptions terse so the overlay
      // fits in narrow terminals.
      title: 'Settings',
      entries: [
        {
          keys: 'Multi-diff summary',
          desc: 'min files before per-tool aggregate footer (Ctrl+M in picker, settings → tools, 0 = off, default 5)',
        },
        {
          keys: 'Index on session start',
          desc: 'run incremental index at startup (Ctrl+I in picker)',
        },
        {
          keys: 'Thinking word',
          desc: 'status-bar working word (Ctrl+W in picker; Enter to type your own)',
        },
        {
          keys: 'Refine countdown / Refine',
          desc: 'prompt refinement delay / on-off (Ctrl+R / Ctrl+E in picker)',
        },
        {
          keys: 'Reasoning mode',
          desc: 'auto / on / off (Ctrl+N in picker)',
        },
        {
          keys: 'Max concurrent',
          desc: 'parallel subagent cap (Ctrl+L in picker, settings → fleet)',
        },
        {
          keys: 'Statusline',
          desc: 'detailed / minimum density (Ctrl+D in picker)',
        },
        {
          keys: 'Default autonomy mode',
          desc: 'off / suggest / auto (Alt+A in picker, settings → autonomy)',
        },
        {
          keys: 'YOLO mode',
          desc: 'skip all confirmation prompts (Alt+Y in picker, settings → UX)',
        },
        {
          keys: 'Token-saving mode',
          desc: 'off / minimal / light / medium / aggressive (Alt+T in picker)',
        },
        {
          keys: 'Context mode',
          desc: 'balanced / frugal / deep / archival (Alt+X in picker, settings → context)',
        },
        {
          keys: 'Confirm before exit',
          desc: 'confirmation on Esc interrupt & Ctrl+C exit (Alt+S in picker, settings → UX)',
        },
        {
          keys: 'Completion chime',
          desc: 'play a sound when agent finishes (Alt+C in picker, settings → UX)',
        },
        {
          keys: 'Log level / Audit level',
          desc: 'console log verbosity / audit depth (Alt+Shift+L / Alt+Shift+A in picker, settings → logging)',
        },
        {
          keys: 'Stream debug logging',
          desc: 'hex-dump raw SSE bytes to stderr (Alt+Shift+B in picker, settings → debug)',
        },
        {
          keys: 'Config scope',
          desc: 'global / project (Alt+Shift+G in picker, settings → debug)',
        },
      ],
    },
    {
      title: 'Tool Colors',
      entries: toolColorLegend(),
    },
  ];
}

/**
 * Generate the tool color legend entries for the help overlay.
 * Shows each tool category with its glyph, color name, and description.
 * Ordered by likely user-facing frequency. Descriptions are kept short
 * to fit in a two-column layout without overflowing narrow terminals.
 */
function toolColorLegend(): HelpEntry[] {
  const tools = [
    // File operations (most common)
    { name: 'read/write', tool: 'read', desc: 'file I/O' },
    { name: 'write', tool: 'write', desc: 'create file' },
    { name: 'edit', tool: 'edit', desc: 'edit file' },
    { name: 'patch', tool: 'patch', desc: 'diff/patch' },
    // Search
    { name: 'search', tool: 'grep', desc: 'search' },
    { name: 'glob', tool: 'glob', desc: 'glob/pattern' },
    // Shell & web
    { name: 'terminal', tool: 'bash', desc: 'shell' },
    { name: 'web', tool: 'fetch', desc: 'web' },
    // Navigation & tree
    { name: 'folder', tool: 'ls', desc: 'navigate' },
    { name: 'tree', tool: 'tree', desc: 'tree view' },
    // VCS
    { name: 'git', tool: 'git', desc: 'git' },
    // Code quality
    { name: 'lint', tool: 'lint', desc: 'lint' },
    { name: 'format', tool: 'format', desc: 'format' },
    { name: 'typecheck', tool: 'typecheck', desc: 'typecheck' },
    // Testing & packages
    { name: 'test', tool: 'test', desc: 'test' },
    { name: 'package', tool: 'install', desc: 'packages' },
    { name: 'audit', tool: 'audit', desc: 'audit' },
    // Planning & tracking
    { name: 'todo', tool: 'todo', desc: 'todos' },
    { name: 'plan', tool: 'plan', desc: 'planning' },
    { name: 'task', tool: 'task', desc: 'tasks' },
    // Docs & scaffolding
    { name: 'document', tool: 'document', desc: 'docs' },
    { name: 'scaffold', tool: 'scaffold', desc: 'scaffold' },
    // Data & logs
    { name: 'json', tool: 'json', desc: 'JSON' },
    { name: 'logs', tool: 'logs', desc: 'logs' },
    // Memory & meta
    { name: 'brain', tool: 'remember', desc: 'memory' },
    { name: 'tool_use', tool: 'tool_use', desc: 'tool chain' },
  ];

  return tools.map(({ name, tool, desc }) => {
    const { glyph, color } = getToolVisual(tool);
    // Format as "▸ bash  shell (red)"
    return {
      keys: `${glyph} ${name}`,
      desc: `${desc} (${color})`,
    };
  });
}

/**
 * Split legend entries into two columns for compact display.
 * Alternates entries between left/right to balance column heights.
 */
function splitIntoColumns(entries: HelpEntry[]): [HelpEntry[], HelpEntry[]] {
  const left: HelpEntry[] = [];
  const right: HelpEntry[] = [];
  for (const entry of entries) {
    if (left.length <= right.length) {
      left.push(entry);
    } else {
      right.push(entry);
    }
  }
  return [left, right];
}

/** Flatten sections into the row list the scroll window slices. */
function buildHelpRows(sections: HelpSection[]): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const sec of sections) {
    rows.push({ kind: 'section', title: sec.title });
    if (sec.title === 'Tool Colors') {
      const [leftCol, rightCol] = splitIntoColumns(sec.entries);
      for (let i = 0; i < leftCol.length; i++) {
        const left = leftCol[i];
        if (!left) continue;
        rows.push({ kind: 'pair', left, right: rightCol[i] });
      }
    } else {
      for (const entry of sec.entries) {
        rows.push({ kind: 'entry', keys: entry.keys, desc: entry.desc });
      }
    }
  }
  return rows;
}

/**
 * Full-width modal cheat-sheet overlay (opened with `?` on an empty prompt,
 * closed with Esc / `?` / `q`). Mirrors the bordered-panel look of the monitor
 * overlays so it sits naturally in the bottom region. Height-limited: only
 * `useMonitorSize().contentRows` rows of the flattened sheet render at a
 * time minus the header and scroll-indicator rows (shared `panelWindow`
 * windowing, `↑ N more` / `↓ N more` indicators), scrolled with ↑/↓ and
 * PgUp/PgDn via
 * the overlay's own `useInput` — the central key router ignores those chords
 * while the modal is open, and the scroll cursor resets when the overlay
 * unmounts. Entries keep one row each
 * (descriptions truncated to the measured content width) so the window height
 * math stays exact; the Tool Colors section renders as two side-by-side
 * sub-columns.
 */
export function HelpOverlay(): React.ReactElement {
  const rows = buildHelpRows(helpSections());
  const size = useMonitorSize();
  const [cursor, setCursor] = useState(0);

  // The always-rendered header row plus the two `N more` indicator rows all
  // render outside the window, so reserve three rows up front — otherwise a
  // mid-scroll frame (both indicators visible) exceeds the bottom-region row
  // budget by one line. Floor 3 keeps `limit ≤ contentRows` even after the
  // budget clamps on tiny terminals.
  const limit = Math.max(3, size.contentRows - 3);
  const lastRow = Math.max(0, rows.length - 1);
  const page = Math.max(1, limit - 1);
  useInput((_input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(lastRow, c + 1));
    else if (key.pageUp) setCursor((c) => Math.max(0, c - page));
    else if (key.pageDown) setCursor((c) => Math.min(lastRow, c + page));
  });

  const win = panelWindow(rows.length, cursor, limit);
  const visible = rows.slice(win.start, win.end);

  // Shared key-column widths: standard rows pad to one width, Tool Colors
  // pair rows to their own so both columns stay aligned.
  const otherKeyWidth = Math.max(
    ...rows
      .filter((r): r is Extract<HelpRow, { kind: 'entry' }> => r.kind === 'entry')
      .map((r) => r.keys.length),
    0,
  );
  const otherKeyCol = otherKeyWidth + 2;
  const descWidth = Math.max(0, size.contentWidth - otherKeyCol);

  const toolKeyWidth = Math.max(
    ...rows
      .filter((r): r is Extract<HelpRow, { kind: 'pair' }> => r.kind === 'pair')
      .flatMap((r) => [r.left.keys.length, r.right?.keys.length ?? 0]),
    0,
  );
  const toolKeyCol = toolKeyWidth + 2;
  // The leftover width is shared by BOTH description columns — giving each
  // the full remainder overflowed the line and wrapped pair rows to two
  // terminal rows, breaking the one-row-per-entry height math.
  const toolDescWidth = Math.max(
    0,
    Math.floor((size.contentWidth - 2 * toolKeyCol - 2) / 2),
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold color={theme.accent}>
          Keyboard shortcuts
        </Text>
        <Text dimColor>· ↑/↓ scroll · PgUp/PgDn page · Esc to close</Text>
      </Box>
      {win.above > 0 ? <Text dimColor>{`  ↑ ${win.above} more`}</Text> : null}
      {visible.map((row, i) => {
        if (row.kind === 'section') {
          return (
            <Text key={`section-${row.title}`} bold color={theme.brand}>
              {row.title}
            </Text>
          );
        }
        if (row.kind === 'entry') {
          return (
            <Text key={`entry-${win.start + i}`}>
              <Text color={theme.accent}>{row.keys.padEnd(otherKeyCol)}</Text>
              <Text dimColor>{truncatePanelText(row.desc, descWidth)}</Text>
            </Text>
          );
        }
        const leftDesc = truncatePanelText(row.left.desc, toolDescWidth).padEnd(
          toolDescWidth + 2,
        );
        return (
          <Text key={`pair-${win.start + i}`}>
            <Text color={theme.accent}>{row.left.keys.padEnd(toolKeyCol)}</Text>
            <Text dimColor>{leftDesc}</Text>
            {row.right ? (
              <>
                <Text color={theme.accent}>{row.right.keys.padEnd(toolKeyCol)}</Text>
                <Text dimColor>{truncatePanelText(row.right.desc, toolDescWidth)}</Text>
              </>
            ) : null}
          </Text>
        );
      })}
      {win.below > 0 ? <Text dimColor>{`  ↓ ${win.below} more`}</Text> : null}
    </Box>
  );
}

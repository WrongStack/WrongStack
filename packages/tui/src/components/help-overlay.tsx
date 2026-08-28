import { Box, Text } from '../ink.js';
import type React from 'react';
import { F_KEY_PANEL_ENTRIES } from '../f-key-panels.js';
import { theme } from '../theme.js';
import { getToolVisual } from '../tool-glyph.js';

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

/**
 * Full-width modal cheat-sheet overlay (opened with `?` on an empty prompt,
 * closed with Esc / `?` / `q`). Mirrors the bordered-panel look of the monitor
 * overlays so it sits naturally in the bottom region. Two columns: the key
 * chord (accent) and its description (dim), with the key column padded to a
 * shared width so descriptions align. The Tool Colors section uses two sub-columns
 * so all legend entries fit without scrolling.
 */
export function HelpOverlay(): React.ReactElement {
  const sections = helpSections();
  // Compute key width only for non-Tool-Colors sections (they use global width)
  const otherSections = sections.filter((s) => s.title !== 'Tool Colors');
  const otherKeyWidth = Math.max(
    ...otherSections.flatMap((s) => s.entries.map((e) => e.keys.length)),
    0,
  );
  const toolSection = sections.find((s) => s.title === 'Tool Colors');
  const toolKeyWidth = toolSection
    ? Math.max(...toolSection.entries.map((e) => e.keys.length), 0)
    : 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold color={theme.accent}>
          Keyboard shortcuts
        </Text>
        <Text dimColor>· Esc to close</Text>
      </Box>
      {sections.map((sec) => {
        // Tool Colors: render in two side-by-side columns
        if (sec.title === 'Tool Colors') {
          const [leftCol, rightCol] = splitIntoColumns(sec.entries);
          return (
            <Box key={sec.title} flexDirection="column" marginTop={1}>
              <Text bold color={theme.brand}>
                {sec.title}
              </Text>
              <Box flexDirection="row" gap={2}>
                {/* Left column */}
                <Box flexDirection="column">
                  {leftCol.map((e, i) => (
                    <Box
                      key={i}
                      flexDirection="row"
                    >
                      <Text color={theme.accent}>{e.keys.padEnd(toolKeyWidth + 2)}</Text>
                      <Text dimColor>{e.desc}</Text>
                    </Box>
                  ))}
                </Box>
                {/* Right column */}
                <Box flexDirection="column">
                  {rightCol.map((e, i) => (
                    <Box
                      key={i}
                      flexDirection="row"
                    >
                      <Text color={theme.accent}>{e.keys.padEnd(toolKeyWidth + 2)}</Text>
                      <Text dimColor>{e.desc}</Text>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Box>
          );
        }
        // All other sections: standard single-column layout
        return (
          <Box key={sec.title} flexDirection="column" marginTop={1}>
            <Text bold color={theme.brand}>
              {sec.title}
            </Text>
            {sec.entries.map((e, i) => (
              <Box
                key={i}
                flexDirection="row"
              >
                <Text color={theme.accent}>{e.keys.padEnd(otherKeyWidth + 2)}</Text>
                <Text dimColor>{e.desc}</Text>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Launch-time feature hints. Shown once per CLI launch — after the
 * provider/model/mode/YOLO prompts have resolved and right before the
 * REPL or TUI starts — to remind users what slash commands, flags, and
 * runtime controls this build ships with. Suppress with `--no-hints` or
 * `WRONGSTACK_NO_HINTS=1`.
 *
 * Rather than dumping every category at once, each launch shows ONE
 * category and rotates to the next on the following launch (round-robin
 * via a tiny persisted cursor). So you see Autonomy one boot, agent tools
 * the next, workspace integrations after that — bite-sized, and the whole
 * set still comes around quickly. `/help` lists everything on demand.
 *
 * The list is intentionally hand-curated rather than auto-derived from
 * the slash-command registry: a one-line blurb tuned for each entry
 * lands better than `command.description` boilerplate.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { color } from '@wrongstack/core/utils';
import type { TerminalRenderer } from './renderer.js';

interface Hint {
  readonly key: string;
  readonly blurb: string;
}

interface HintGroup {
  readonly title: string;
  readonly items: readonly Hint[];
}

const GROUPS: readonly HintGroup[] = [
  {
    title: 'Autonomy',
    items: [
      { key: '/goal <text>', blurb: 'lock in a verifiable mission — only Esc / Ctrl+C interrupt' },
      {
        key: '/autonomy eternal',
        blurb: 'sense → decide → execute → reflect loop until you stop it',
      },
      {
        key: '--eternal "<mission>"',
        blurb: 'boot directly into the eternal-autonomy engine with a mission',
      },
      {
        key: '/autonomy on|suggest',
        blurb: 'self-driving: auto-pick next step or just suggest it',
      },
    ],
  },
  {
    title: 'Agents & fleet',
    items: [
      {
        key: '/delegate [--role=<role>] <task>',
        blurb: 'route work to a specialist; omit --role for automatic selection',
      },
      {
        key: '/spawn [-p <provider>] [-m <model>] [-n <name>] <task>',
        blurb: 'launch one isolated subagent with optional runtime overrides',
      },
      {
        key: '/agents [list|show <id>|stream on|off]',
        blurb: 'open the TUI monitor, inspect a subagent, or control its activity stream',
      },
      {
        key: '/fleet status|usage|kill|log|manifest',
        blurb: 'inspect and control the active subagent fleet',
      },
    ],
  },
  {
    title: 'Steering',
    items: [
      {
        key: 'Esc (while busy)',
        blurb: 'soft interrupt — next message carries a STEERING preamble',
      },
      { key: '/steer <text>', blurb: 'mid-flight redirect, works when Esc is eaten by tmux' },
      { key: '/btw <note>', blurb: 'non-aborting nudge — agent folds it in at its next step' },
      {
        key: 'Ctrl+C × 1 / × 2 / × 3',
        blurb: 'cancel iteration · force-exit Ink · hard exit(130)',
      },
    ],
  },
  {
    title: 'Modes & context',
    items: [
      {
        key: '/mode',
        blurb: 'switch persona: code-reviewer, debugger, architect, tester, devops, …',
      },
      { key: '/model', blurb: 'two-step provider → model picker, hot-swap at runtime' },
      { key: '/yolo on|off|toggle', blurb: 'auto-approve tool calls without restart' },
      {
        key: '/context mode frugal|balanced|deep|archival',
        blurb: 'pick how aggressively history is trimmed',
      },
      { key: '/compact', blurb: 'manually compact the in-flight context window' },
      {
        key: '/plan show|add|start|done',
        blurb: 'strategic roadmap, survives /resume across sessions',
      },
    ],
  },
  {
    title: 'Workspace tools',
    items: [
      {
        key: '@<query>',
        blurb: 'search project files and insert a path into the prompt',
      },
      {
        key: 'Alt+V  ·  /image',
        blurb: 'attach a clipboard image in the TUI',
      },
      {
        key: '/mcp  ·  wstack mcp add <name>',
        blurb: 'inspect or connect MCP servers',
      },
      {
        key: '/plugin install|enable|disable <name>',
        blurb: 'manage optional integrations such as Telegram or LSP',
      },
      {
        key: '/skill  ·  /init  ·  /commit',
        blurb: 'browse skills · scaffold project guidance · draft a commit',
      },
      {
        key: '/diag  ·  wstack usage  ·  wstack resume <id>',
        blurb: 'inspect diagnostics, review costs, or continue an earlier session',
      },
    ],
  },
] as const;

/**
 * Total number of hints across all groups. Exported so callers can
 * assert "≥ 20" in tests without re-counting.
 */
export const HINT_COUNT: number = GROUPS.reduce((n, g) => n + g.items.length, 0);

/** Number of rotating categories. */
export const HINT_GROUP_COUNT: number = GROUPS.length;

/** Category titles, in rotation order. Exported for tests. */
export const HINT_GROUP_TITLES: readonly string[] = GROUPS.map((g) => g.title);

function shouldSuppress(flags: Record<string, string | boolean>): boolean {
  if (flags['no-hints'] === true) return true;
  if (flags['hints'] === false) return true;
  const env = process.env.WRONGSTACK_NO_HINTS;
  if (env && env !== '0' && env.toLowerCase() !== 'false') return true;
  return false;
}

interface LaunchHintOptions {
  /**
   * File holding the rotation cursor. When set, each call advances it so
   * consecutive launches show different categories (round-robin). Missing
   * or unreadable file starts the rotation at the first category.
   */
  readonly cursorFile?: string | undefined;
  /**
   * Force a specific category index (wraps around). Overrides the cursor.
   * Mainly for tests and `--hints`-style explicit selection.
   */
  readonly groupIndex?: number | undefined;
  /** Terminal width used to wrap long hint rows. Defaults to stdout width. */
  readonly termWidth?: number | undefined;
}

const DEFAULT_TERM_WIDTH = 80;
const MIN_TERM_WIDTH = 20;
const HINT_INDENT = '     ';
const HINT_CONTINUATION_INDENT = '       ';

const wrap = (n: number): number => ((n % GROUPS.length) + GROUPS.length) % GROUPS.length;

function displayWidth(value: string): number {
  return [...value].length;
}

function wrapWords(value: string, firstWidth: number, continuationWidth = firstWidth): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let width = Math.max(1, firstWidth);

  for (const sourceWord of words) {
    let word = sourceWord;
    while (word) {
      if (line) {
        if (displayWidth(line) + 1 + displayWidth(word) <= width) {
          line += ` ${word}`;
          word = '';
        } else {
          lines.push(line);
          line = '';
          width = Math.max(1, continuationWidth);
        }
        continue;
      }

      if (displayWidth(word) <= width) {
        line = word;
        word = '';
      } else {
        const characters = [...word];
        lines.push(characters.slice(0, width).join(''));
        word = characters.slice(width).join('');
        width = Math.max(1, continuationWidth);
      }
    }
  }

  if (line) lines.push(line);
  return lines;
}

function renderHintLines(item: Hint, termWidth: number): string[] {
  const inline = `${HINT_INDENT}${item.key}  — ${item.blurb}`;
  if (displayWidth(inline) <= termWidth) {
    return [`${HINT_INDENT}${color.bold(item.key)}  ${color.dim('—')} ${color.dim(item.blurb)}`];
  }

  const lines: string[] = [];
  const keyLines = wrapWords(
    item.key,
    termWidth - displayWidth(HINT_INDENT),
    termWidth - displayWidth(HINT_CONTINUATION_INDENT),
  );
  keyLines.forEach((line, index) => {
    const indent = index === 0 ? HINT_INDENT : HINT_CONTINUATION_INDENT;
    lines.push(`${indent}${color.bold(line)}`);
  });

  const blurbLines = wrapWords(
    `— ${item.blurb}`,
    termWidth - displayWidth(HINT_CONTINUATION_INDENT),
  );
  for (const line of blurbLines) lines.push(`${HINT_CONTINUATION_INDENT}${color.dim(line)}`);
  return lines;
}

function renderHeaderLines(group: HintGroup, groupIndex: number, termWidth: number): string[] {
  const progress = `${groupIndex + 1}/${GROUPS.length}`;
  const plain = `  ${group.title}  ${progress}`;
  if (displayWidth(plain) <= termWidth) {
    return [
      `  ${color.cyan('◇')} ${color.bold(group.title)} ${color.dim(progress)}`,
      `  ${color.dim('─'.repeat(Math.min(termWidth - 2, 48)))}`,
    ];
  }

  return [
    `  ${color.cyan('◇')} ${color.bold(group.title)}`,
    `  ${color.dim('─'.repeat(Math.min(termWidth - 2, 48)))}`,
  ];
}

function renderFooterLines(termWidth: number): string[] {
  const footer = '/help lists everything · hide with --no-hints';
  if (displayWidth(`  ${footer}`) <= termWidth) {
    return [
      `  ${color.dim('─'.repeat(Math.min(termWidth - 2, 48)))}`,
      `  ${color.dim(`${color.bold('/help')} lists everything · hide with ${color.bold('--no-hints')}`)}`,
    ];
  }

  return [...wrapWords(footer, termWidth - 2).map((line) => `  ${color.dim(line)}`)];
}

/**
 * Pick the category to show. Priority: explicit `groupIndex` → persisted
 * round-robin cursor → random. Advancing the cursor is best-effort; any
 * filesystem error falls back to a random category so a boot is never
 * blocked on hint bookkeeping.
 */
async function pickGroupIndex(opts: LaunchHintOptions): Promise<number> {
  if (typeof opts.groupIndex === 'number') return wrap(opts.groupIndex);
  if (opts.cursorFile) {
    try {
      let current = 0;
      try {
        const raw = await fs.readFile(opts.cursorFile, 'utf8');
        const parsed = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(parsed)) current = wrap(parsed);
      } catch {
        // No cursor yet — start at the first category.
      }
      await fs.mkdir(path.dirname(opts.cursorFile), { recursive: true });
      await fs.writeFile(opts.cursorFile, String(wrap(current + 1)));
      return current;
    } catch {
      // Fall through to random on any FS error.
    }
  }
  return Math.floor(Math.random() * GROUPS.length);
}

/**
 * Print one rotating category of launch hints to `renderer`. No-op when
 * suppressed via `--no-hints` or `WRONGSTACK_NO_HINTS=1`.
 */
export async function printLaunchHints(
  renderer: Pick<TerminalRenderer, 'write'>,
  flags: Record<string, string | boolean>,
  opts: LaunchHintOptions = {},
): Promise<void> {
  if (shouldSuppress(flags)) return;

  const idx = await pickGroupIndex(opts);
  const group = GROUPS[idx];
  if (!group) return;
  const termWidth = Math.max(
    MIN_TERM_WIDTH,
    Math.floor(opts.termWidth ?? process.stdout.columns ?? DEFAULT_TERM_WIDTH),
  );

  const lines: string[] = [];
  lines.push('');
  lines.push(...renderHeaderLines(group, idx, termWidth));
  for (const item of group.items) lines.push(...renderHintLines(item, termWidth));
  lines.push('');
  lines.push(...renderFooterLines(termWidth));
  lines.push('');

  renderer.write(`${lines.join('\n')}\n`);
}

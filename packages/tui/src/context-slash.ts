import type { Context } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import { fmtRatioPct } from './components/status-bar-format.js';

interface ContextSlashDeps {
  /** Bridge from slash-command execution to the mounted TUI reducer. */
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
  /** Small history-safe snapshot shown after the interactive panel opens. */
  getSummary?: (() => ContextPanelSummary) | undefined;
  /**
   * The text `/context` command this one shadows (the CLI's
   * `buildContextCommand`). Bare `/context` opens the panel; every
   * sub-command (`detail`, `mode`, `limit`, `thresholds`, `cache`,
   * `repair`, …) is delegated here verbatim so none of that surface is
   * lost. Without a fallback (e.g. isolated unit test) sub-commands print a
   * short usage line and the panel path still works.
   */
  fallback?: SlashCommand | undefined;
}

interface ContextPanelSummary {
  contextPct?: number | undefined;
  contextTokens?: number | undefined;
  contextMaxTokens?: number | undefined;
  memoryTotal?: number | undefined;
  memoryCtx: number;
  memoryPending: number;
  memoryLeft: number;
}

/** Compact context-pressure bar shared by the interactive Ink panel. */
export function contextBar(pct: number, width: number): string {
  if (pct <= 0) return `[${'░'.repeat(width)}]   0%`;
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const label = ` ${fmtRatioPct(pct)}`;
  const bar = `[${'█'.repeat(Math.max(1, filled))}${'░'.repeat(Math.max(0, empty))}]`;
  return bar.length + label.length <= width + 4
    ? `${bar}${label}`
    : `${'█'.repeat(Math.max(1, filled))}${'░'.repeat(Math.max(0, empty))} ${label}`;
}

/**
 * TUI `/context` is panel-first. Bare `/context` (and `window` / `--window`)
 * opens the interactive tabbed panel and emits nothing to chat history. Every
 * other argument is delegated to the underlying text command (`deps.fallback`,
 * the CLI's `buildContextCommand`) so `/context detail|mode|limit|thresholds|
 * cache|repair` keep working exactly as before.
 *
 * This command must be registered so it *wins* over the CLI's same-named
 * command — the registry's rule is "first core registration of a name wins"
 * (`slash-command-registry.ts`), and the CLI registers first at boot. The App
 * captures the CLI command as `fallback`, unregisters it, then registers this
 * wrapper (see app.tsx). Without that override, this whole file is dead code
 * and `/context` prints the CLI's text summary instead of opening the panel.
 */
export function createContextSlashCommand(deps: ContextSlashDeps): SlashCommand {
  return {
    name: 'context',
    aliases: ['ctx'],
    description: 'Open the interactive provider-context and SAGE monitor.',
    argsHint: '[window|detail|mode|limit|thresholds|cache|repair]',
    category: 'Inspect',
    help:
      'Usage:\n' +
      '  /context                  — open the interactive context monitor (tabbed panel)\n' +
      '  /context window           — same as above\n' +
      '  /context detail           — text breakdown in chat history\n' +
      '  /context mode [id]        — list / switch context-window modes\n' +
      '  /context limit [tokens]   — show / set the effective context window\n' +
      '  /context thresholds …     — set compaction thresholds\n' +
      '  /context cache            — prompt-cache report\n' +
      '  /context repair           — repair orphan tool_use/tool_result blocks\n',
    async run(args: string, ctx?: Context) {
      const trimmed = args.trim().toLowerCase();
      const panelRequest = trimmed === '' || trimmed === 'window' || trimmed === '--window';

      if (!panelRequest) {
        // Sub-command → hand off to the CLI text command untouched.
        if (deps.fallback) return deps.fallback.run(args, ctx);
        return { message: 'Usage: /context [window|detail|mode|limit|thresholds|cache|repair]' };
      }

      const opened = deps.onPanelOpen?.current?.('toggleContextPanel') ?? false;
      // Panel opened: emit NOTHING to chat history. The app's slash handler
      // only pushes an entry when `res.message` is truthy (`if (res?.message)`),
      // so the empty string is dropped (same pattern /kanban open uses). The
      // panel shows everything the old summary did and more, so the extra chat
      // row was just noise. `getSummary` stays wired for headless/test callers.
      if (opened) return { message: '' };

      // No panel bridge (headless / plain REPL): fall back to the text summary
      // so `/context` still does something useful there.
      if (deps.fallback) return deps.fallback.run(args, ctx);
      return { message: 'Interactive context panel is unavailable in this TUI instance.' };
    },
  };
}

export function formatContextPanelSummary(summary: ContextPanelSummary | undefined): string {
  if (!summary) return 'Context panel opened.';
  const contextParts = ['Context panel opened'];
  if (summary.contextPct !== undefined) {
    contextParts.push(fmtRatioPct(Math.max(0, summary.contextPct)));
  }
  if (
    summary.contextTokens !== undefined &&
    summary.contextMaxTokens !== undefined &&
    summary.contextMaxTokens > 0
  ) {
    contextParts.push(
      `${formatTokens(summary.contextTokens)}/${formatTokens(summary.contextMaxTokens)}`,
    );
  }

  const memoryParts = [
    'Memory',
    summary.memoryTotal === undefined ? undefined : `${summary.memoryTotal} total`,
    `${summary.memoryCtx} ctx`,
    `${summary.memoryPending} pending`,
    summary.memoryLeft > 0 ? `${summary.memoryLeft} left` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${contextParts.join(' · ')}\n${memoryParts.join(' · ')}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.max(0, Math.round(value)));
}

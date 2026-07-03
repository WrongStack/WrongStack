import type { SlashCommand } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { clearSuggestions, getSuggestions } from './suggestion-store.js';

/**
 * `/next` — toggle next-task prediction AND select stored suggestions.
 *
 * Without numeric args: toggles prediction display (existing behavior).
 *
 * With numeric args (`/next 1`, `/next 1 2 3`): selects the corresponding
 * suggestions from the stored list (populated by `/suggest` or by automatic
 * suggestion generation after each turn). Each selected suggestion is
 * injected as the next user message, bypassing refinement/classification.
 *
 * `/next list` shows the current suggestion list.
 *
 * When prediction is enabled, the REPL runs a lightweight single-shot LLM
 * prediction after each completed turn and shows the 1-3 most likely next
 * steps (display-only — nothing is executed). The toggle is persisted to
 * config so it survives restarts.
 */
export function buildNextCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'next',
    category: 'Agent',
    description: 'Show or select next-step suggestions. /next 1 to execute, /next list to view.',
    argsHint: '[on|off|toggle|list|clear|1 2 3...]',
    help: [
      'Usage:',
      '  /next                 Show whether next-task prediction is on or off',
      '  /next on              Enable — after each turn, show 1-3 predicted next steps',
      '  /next off             Disable (default)',
      '  /next toggle          Flip the current state',
      '  /next list            Show the current suggestion list',
      '  /next clear           Clear the suggestion list',
      '  /next 1               Execute suggestion #1 as the next agent turn',
      '  /next 1 2 3           Execute suggestions 1, 2, and 3 in sequence',
      '  /next 1,2,3           Same — comma separators work too',
      '',
      'Suggestions are generated automatically after each turn (when prediction is',
      `on) or manually via ${color.cyan('/suggest')}. Selected suggestions execute`,
      'immediately — no refinement or classification step.',
    ].join('\n'),
    async run(args) {
      const trimmed = args.trim();

      // ── Numeric selection: /next 1, /next 1 2 3, /next 1,2,3 ──────────
      if (/^\d[\d,\s]*$/.test(trimmed) && /\d/.test(trimmed)) {
        return handleSelection(trimmed, opts);
      }

      const arg = trimmed.toLowerCase();

      // ── List: show current suggestions ─────────────────────────────────
      if (arg === 'list' || arg === 'ls' || arg === 'show') {
        return handleList(opts);
      }

      // ── Clear: reset suggestion list ─────────────────────────────────
      if (arg === 'clear' || arg === 'reset') {
        clearSuggestions();
        opts.onSuggestions?.([]);
        return { message: color.dim('Suggestion list cleared.') };
      }

      // ── Prediction toggle (existing behavior) ──────────────────────────
      if (!opts.onNextPredict) {
        const msg = 'Next-task prediction is not available in this session.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      const current = opts.onNextPredict();

      const label = (on: boolean): string =>
        on
          ? `${color.cyan('ON')} ${color.dim('(predicted next steps shown after each turn)')}`
          : `${color.green('OFF')} ${color.dim('(no predictions)')}`;

      // No argument — report status.
      if (!arg || arg === 'status') {
        const stored = getSuggestions();
        const suggestions = stored.length > 0 ? stored : (opts.onSuggestions?.() ?? []);
        const msg = [
          `Next-task prediction: ${label(current)}`,
          suggestions.length > 0
            ? color.dim(
                `  ${suggestions.length} suggestion(s) available — use /next list to view, /next 1 to execute`,
              )
            : color.dim('  No suggestions stored — use /suggest to generate'),
        ].join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      let target: boolean;
      if (arg === 'on' || arg === 'enable' || arg === 'true') {
        target = true;
      } else if (arg === 'off' || arg === 'disable' || arg === 'false') {
        target = false;
      } else if (arg === 'toggle' || arg === 'cycle') {
        target = !current;
      } else {
        const msg = `Unknown argument: ${arg}. Use /next on, off, toggle, list, clear, or a number (e.g. /next 1).`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      const now = opts.onNextPredict(target);
      const msg = `Next-task prediction: ${label(now)}`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}

/**
 * Handle numeric selection: /next 1, /next 1 2 3, /next 1,2,3
 * Parses the numbers, fetches the corresponding suggestions, and
 * returns them as runText to inject into the next agent turn.
 */
function handleSelection(
  input: string,
  opts: SlashCommandContext,
): { message: string; runText?: string } {
  // Parse numbers: "1 2 3" or "1,2,3" or "1, 2, 3"
  const parts = input.split(/[\s,]+/).filter(Boolean);
  const indices = parts.map((p) => Number.parseInt(p, 10)).filter((n) => !Number.isNaN(n) && n > 0);

  if (indices.length === 0) {
    return {
      message: color.amber('No valid suggestion numbers found. Use /next 1, /next 1 2 3, etc.'),
    };
  }

  // Use shared module-level store first (bypasses callback indirection);
  // fall back to opts.onSuggestions for backward compatibility.
  const suggestions =
    getSuggestions().length > 0 ? getSuggestions() : (opts.onSuggestions?.() ?? []);

  if (suggestions.length === 0) {
    return {
      message: color.amber(
        'No suggestions available. Run /suggest to generate, or finish any open todos first — <next_steps> is suppressed while todos are pending.',
      ),
    };
  }

  // Validate indices
  const invalid = indices.filter((i) => i > suggestions.length);
  if (invalid.length > 0) {
    const max = suggestions.length;
    return {
      message: color.amber(
        `Invalid suggestion number(s): ${invalid.join(', ')}. Valid range: 1–${max}.`,
      ),
    };
  }

  // Build the combined runText
  const selected = indices
    .map((i) => suggestions[i - 1])
    .filter((s): s is string => s !== undefined);

  if (selected.length === 1) {
    const text = selected[0] ?? '';
    return {
      message: `${color.green('▶')} Executing suggestion #${indices[0]}: ${color.dim(text)}`,
      runText: text,
    };
  }

  // Multiple selections — join with newlines, prefix with a brief header
  const tasks = selected.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const runText = [
    `## Execute the following tasks in order`,
    '',
    tasks,
    '',
    'Complete each task before moving to the next. Report results as you go.',
  ].join('\n');

  return {
    message: `${color.green('▶')} Executing ${selected.length} tasks: ${indices.join(', ')}`,
    runText,
  };
}

/**
 * Display the current suggestion list.
 */
function handleList(opts: SlashCommandContext): { message: string } {
  // Use shared module-level store first; fall back to opts.onSuggestions
  const suggestions =
    getSuggestions().length > 0 ? getSuggestions() : (opts.onSuggestions?.() ?? []);

  if (suggestions.length === 0) {
    return {
      message: [
        color.dim('No suggestions available.'),
        '',
        `Generate suggestions with ${color.cyan('/suggest')} or enable`,
        `prediction with ${color.cyan('/next on')}.`,
      ].join('\n'),
    };
  }

  const lines = [
    `  ${color.cyan('💡 Suggestions')}  ${color.dim(`(use /next 1, /next 1 2 3 to execute)`)}`,
    '',
  ];

  for (let i = 0; i < suggestions.length; i++) {
    lines.push(`  ${color.bold(`${i + 1}.`)} ${suggestions[i]}`);
  }

  return { message: lines.join('\n') };
}

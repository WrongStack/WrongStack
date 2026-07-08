import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Context, SlashCommand } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import { parseNextSteps } from '@wrongstack/tools/next-steps';
import type { SlashCommandContext } from './index.js';
import { setSuggestions } from './suggestion-store.js';
import { toErrorMessage } from '@wrongstack/core/utils';

/**
 * Collect project context for the suggestion subagent.
 * Goal: give the subagent enough breadcrumbs to generate useful suggestions
 * without overwhelming it with raw message dumps.
 */
function collectContext(opts: { cwd: string; projectRoot: string }): string {
  const parts: string[] = [];

  // ── Git status ──────────────────────────────────────────────────────────
  try {
    const gitStatus = execFileSync('git', ['status', '--short', '--branch'], {
      cwd: opts.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (gitStatus) {
      parts.push('### Git Status', '```', gitStatus, '```');
    }
  } catch {
    // not a git repo or git unavailable
  }

  // ── Working directory hint ──────────────────────────────────────────────
  parts.push(`Working directory: ${opts.cwd}`);
  parts.push(`Project root: ${opts.projectRoot}`);

  return parts.join('\n');
}

/**
 * Build the subagent task prompt for suggestion generation.
 */
function buildSuggestPrompt(contextText: string): string {
  return [
    '## Suggest Next Steps',
    '',
    'Based on the current project state below, generate 3-5 actionable next-step',
    'suggestions. Each suggestion must be a single imperative sentence that can be',
    'executed immediately. Be specific — mention file names, tool names, or commands',
    'when relevant. Do NOT include preamble, explanation, or wrap in code blocks.',
    '',
    'Rules:',
    '- One suggestion per line, prefixed with the number (e.g. "1. Run tests...")',
    '- Order by priority: most impactful first',
    '- Suggestions should be independent — user can pick any subset',
    '- If nothing is needed, say "No pending actions — everything is up to date."',
    '',
    contextText || '(No project context available — suggest generic next steps.)',
    '',
    'Output format (strict — no other text):',
    '1. First suggestion here',
    '2. Second suggestion here',
    '3. Third suggestion here',
  ].join('\n');
}

/** Reuse subagent-generated suggestions within this window to avoid a fresh
 *  spawn on rapid re-invocation. `/suggest --fresh` bypasses it. */
const SUGGEST_CACHE_TTL_MS = 60_000;
let suggestCache: { suggestions: string[]; at: number } | null = null;

export function buildSuggestCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'suggest',
    aliases: ['next-steps', 'what-next'],
    category: 'Agent',
    description: 'Generate context-aware next-step suggestions for the current session.',
    argsHint: '[--fast] [--fresh]',
    help: [
      'Usage:',
      '  /suggest           Generate suggestions using a lightweight subagent',
      '  /suggest --fast    Heuristic-only suggestions (no subagent, instant)',
      '  /suggest --fresh   Force regeneration (ignore the recent-result cache)',
      '',
      'Analyzes the current session state (git status, working directory, recent',
      'activity) and generates 3-5 actionable next-step suggestions. Suggestions',
      'are stored and can be selected with `/next 1`, `/next 1 2 3`, etc.',
      '',
      'Use `/next list` to see the current suggestions at any time.',
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const trimmed = args.trim().toLowerCase();
      const fast = /\b(--fast|-f)\b/.test(trimmed);
      const fresh = /--fresh\b/.test(trimmed);

      // ── Fast path: heuristic suggestions (no subagent) ──────────────────
      if (fast) {
        const suggestions = generateHeuristicSuggestions(opts);
        setSuggestions(suggestions);
        opts.onSuggestions?.(suggestions);
        const display = formatSuggestions(suggestions);
        return { message: display };
      }

      // ── Full path: subagent-powered suggestions ─────────────────────────
      if (!opts.onSpawnAndWait) {
        // Fall back to heuristic if subagent not available
        const suggestions = generateHeuristicSuggestions(opts);
        setSuggestions(suggestions);
        opts.onSuggestions?.(suggestions);
        const display =
          formatSuggestions(suggestions) +
          '\n' +
          color.dim('(Heuristic fallback — multi-agent not enabled)');
        return { message: display };
      }

      // Reuse a recent result rather than spawning again, unless --fresh.
      if (!fresh && suggestCache && Date.now() - suggestCache.at < SUGGEST_CACHE_TTL_MS) {
        setSuggestions(suggestCache.suggestions);
        opts.onSuggestions?.(suggestCache.suggestions);
        const ageSec = Math.round((Date.now() - suggestCache.at) / 1000);
        return {
          message:
            formatSuggestions(suggestCache.suggestions) +
            '\n' +
            color.dim(`(cached ${ageSec}s ago — /suggest --fresh to regenerate)`),
        };
      }

      const contextText = collectContext({
        cwd: opts.cwd,
        projectRoot: opts.projectRoot,
      });

      const task = buildSuggestPrompt(contextText);

      opts.renderer.write(color.dim('Generating suggestions...'));

      try {
        const raw = await opts.onSpawnAndWait(task, {
          name: 'suggest',
        });

        // Parse the subagent output — extract numbered lines
        const suggestions = parseSuggestions(raw);
        if (suggestions.length === 0) {
          const fallback = ['No pending actions — everything is up to date.'];
          setSuggestions(fallback);
          opts.onSuggestions?.(fallback);
          return { message: formatSuggestions(fallback) };
        }

        setSuggestions(suggestions);
        opts.onSuggestions?.(suggestions);
        suggestCache = { suggestions, at: Date.now() };
        return { message: formatSuggestions(suggestions) };
      } catch (err) {
        const msg = `Suggestion generation failed: ${toErrorMessage(err)}`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }
    },
  };
}

/**
 * Parse subagent output into suggestion lines.
 * Delegated to parseNextSteps (raw mode — no heading required).
 */
function parseSuggestions(raw: string): string[] {
  const { texts } = parseNextSteps(raw, false, false); // permissive, no heading required
  if (texts.length > 0) return texts;

  // Fallback: take the first 5 non-empty lines that look like suggestions
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 10 && !l.startsWith('#') && !l.startsWith('```'))
    .slice(0, 5);
}

/**
 * Generate heuristic suggestions without an LLM subagent.
 * Fast, deterministic, good enough for common patterns.
 */
function generateHeuristicSuggestions(opts: SlashCommandContext): string[] {
  const suggestions: string[] = [];

  try {
    const gitStatus = execFileSync('git', ['status', '--short'], {
      cwd: opts.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();

    if (gitStatus) {
      const staged = gitStatus.split('\n').filter((l) => /^[MADRC]/.test(l)).length;
      const unstaged = gitStatus.split('\n').filter((l) => /^.[MADRC]/.test(l)).length;
      const untracked = gitStatus.split('\n').filter((l) => l.startsWith('??')).length;

      if (staged > 0) {
        suggestions.push(`Commit ${staged} staged file(s) with a descriptive message`);
      }
      if (unstaged > 0) {
        suggestions.push(`Stage and review ${unstaged} modified file(s)`);
      }
      if (untracked > 0) {
        suggestions.push(`Review ${untracked} untracked file(s) — add to git or .gitignore`);
      }
    }
  } catch {
    // not a git repo
  }

  // Project-shape hints — detect common files and suggest relevant actions.
  const root = opts.projectRoot;
  const has = (...rel: string[]): boolean => rel.some((r) => existsSync(path.join(root, r)));
  if (has('package.json')) {
    suggestions.push('Run the npm/pnpm test suite to verify everything passes');
  }
  if (has('Dockerfile', 'docker-compose.yml', 'compose.yaml')) {
    suggestions.push('Build the Docker image and verify the container starts');
  }
  if (has('Makefile')) {
    suggestions.push('Run `make` (or `make test`) to exercise the build targets');
  }
  if (has('pyproject.toml', 'requirements.txt', 'setup.py')) {
    suggestions.push('Run pytest and the linters for the Python package');
  }
  if (has('.github/workflows')) {
    suggestions.push('Check the CI workflow status for the latest push');
  }

  // Generic fallback if nothing found
  if (suggestions.length === 0) {
    suggestions.push('Review recent changes with a diff');
    suggestions.push('Run the test suite to verify everything passes');
    suggestions.push('Check for lint or type errors');
  }

  return suggestions.slice(0, 5);
}

/**
 * Format suggestions for display in the REPL/TUI.
 */
function formatSuggestions(suggestions: string[]): string {
  if (suggestions.length === 0) {
    return color.dim('No suggestions available.');
  }

  const lines = [
    `  ${color.cyan('💡 Next steps')}  ${color.dim('(use /next 1, /next 2, or /next 1 2 3)')}`,
    '',
  ];

  for (let i = 0; i < suggestions.length; i++) {
    const num = color.bold(`${i + 1}.`);
    const text = suggestions[i] ?? '';
    lines.push(`  ${num} ${text}`);
  }

  return lines.join('\n');
}

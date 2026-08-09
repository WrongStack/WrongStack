import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { parseNextSteps } from '@wrongstack/tools/next-steps';
import type { SlashCommandContext } from './command-context.js';
import { setSuggestions } from './suggestion-store.js';

/**
 * Collect project context for the suggestion subagent.
 * Goal: give the subagent enough breadcrumbs to generate useful suggestions
 * without overwhelming it with raw message dumps.
 */
function readGitStatus(projectRoot: string, includeBranch: boolean): Promise<string> {
  const args = ['status', '--short'];
  if (includeBranch) args.push('--branch');
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => resolve(error ? '' : stdout.trim()),
    );
  });
}

async function collectContext(opts: { cwd: string; projectRoot: string }): Promise<string> {
  const parts: string[] = [];

  // ── Git status ──────────────────────────────────────────────────────────
  const gitStatus = await readGitStatus(opts.projectRoot, true);
  if (gitStatus) {
    parts.push('### Git Status', '```', gitStatus, '```');
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
    'Based on the current project state below, generate 3-5 exact natural-language',
    'prompt messages that the user could submit back to the coding agent through the',
    'TUI or WebUI. Each prompt must ask the agent to perform useful work immediately.',
    'Agent-directed imperatives are valid and do not need to be shell commands.',
    'Never output a human-only chore or an instruction that expects the user to do',
    'the work after selecting it. Be specific — mention relevant files or tools.',
    'Do NOT include preamble, explanation, or wrap the output in code blocks.',
    '',
    'Rules:',
    '- One prompt per line, prefixed with the number (e.g. "1. Run the tests and fix any failures")',
    '- Order by priority: most impactful first',
    '- Prompts should be independent — the user can submit any subset',
    '- If nothing is needed, output exactly "NONE"',
    '',
    contextText || '(No project context available — suggest generic next steps.)',
    '',
    'Output format (strict — no other text):',
    '1. Run the focused tests and fix any failures',
    '2. Review the current diff and implement any necessary corrections',
    '3. Update the relevant documentation to match the implementation',
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
        const suggestions = await generateHeuristicSuggestions(opts);
        setSuggestions(suggestions);
        opts.onSuggestions?.(suggestions);
        const display = formatSuggestions(suggestions);
        return { message: display };
      }

      // ── Full path: subagent-powered suggestions ─────────────────────────
      if (!opts.onSpawnAndWait) {
        // Fall back to heuristic if subagent not available
        const suggestions = await generateHeuristicSuggestions(opts);
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

      const contextText = await collectContext({
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
          const fallback: string[] = [];
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
  const trimmed = raw.trim();
  if (/^none\b/i.test(trimmed) || /no (?:pending actions|further steps)/i.test(trimmed)) {
    return [];
  }

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
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateHeuristicSuggestions(opts: SlashCommandContext): Promise<string[]> {
  const suggestions: string[] = [];

  const gitStatus = await readGitStatus(opts.projectRoot, false);
  if (gitStatus) {
    const staged = gitStatus.split('\n').filter((l) => /^[MADRC]/.test(l)).length;
    const unstaged = gitStatus.split('\n').filter((l) => /^.[MADRC]/.test(l)).length;
    const untracked = gitStatus.split('\n').filter((l) => l.startsWith('??')).length;

    if (staged > 0) {
      suggestions.push(`Commit ${staged} staged file(s) with a descriptive message`);
    }
    if (unstaged > 0) {
      suggestions.push(
        `Review and stage the ${unstaged} modified file(s), fixing any issue you find`,
      );
    }
    if (untracked > 0) {
      suggestions.push(
        `Review the ${untracked} untracked file(s) and add each to Git or .gitignore as appropriate`,
      );
    }
  }

  // Project-shape hints — detect common files and suggest relevant actions.
  const root = opts.projectRoot;
  const has = async (...rel: string[]): Promise<boolean> =>
    (await Promise.all(rel.map((item) => pathExists(path.join(root, item))))).some(Boolean);
  const [hasNode, hasDocker, hasMake, hasPython, hasCi] = await Promise.all([
    has('package.json'),
    has('Dockerfile', 'docker-compose.yml', 'compose.yaml'),
    has('Makefile'),
    has('pyproject.toml', 'requirements.txt', 'setup.py'),
    has('.github/workflows'),
  ]);
  if (hasNode) {
    suggestions.push('Run the npm/pnpm test suite and fix any failures');
  }
  if (hasDocker) {
    suggestions.push('Build the Docker image, verify the container starts, and fix any failures');
  }
  if (hasMake) {
    suggestions.push('Run the relevant make build and test targets, then fix any failures');
  }
  if (hasPython) {
    suggestions.push('Run pytest and the Python linters, then fix any failures');
  }
  if (hasCi) {
    suggestions.push('Inspect the latest CI workflow run and fix any failures');
  }

  // Generic fallback if nothing found
  if (suggestions.length === 0) {
    suggestions.push('Review the recent diff and implement any necessary corrections');
    suggestions.push('Run the test suite and fix any failures');
    suggestions.push('Run the linter and type checker, then fix any errors');
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

import { renderEnsembleText, runEnsemble } from '@wrongstack/acp';
import type { SlashCommand } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

/**
 * /ensemble <agent-csv> <task description>
 *
 * Fan a single task out to multiple ACP-supporting agents in parallel.
 * Each agent runs in its own process; the command waits for all of them
 * and reports per-agent outcomes.
 *
 * Examples:
 *   /ensemble claude-code,gemini-cli "review this diff"
 *   /ensemble claude-code,codex-cli "refactor auth/session.ts"
 *
 * Run /ensemble (no args) to see usage and the list of available agents.
 */
export function buildEnsembleCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'ensemble',
    category: 'Agent',
    description:
      'Fan a task out to multiple ACP agents in parallel (claude-code, gemini-cli, codex-cli, etc.).',
    argsHint: '<agent-ids-csv> <task description>',
    help: [
      'Fan a single task out to multiple ACP-supporting agents in parallel.',
      '',
      'Usage:',
      '  /ensemble <agent-ids-csv> <task description>',
      '',
      'Examples:',
      '  /ensemble claude-code,gemini-cli "review this diff"',
      '  /ensemble claude-code,codex-cli "refactor auth/session.ts"',
      '  /ensemble claude-code,gemini-cli,codex-cli "explain the v1 protocol"',
      '',
      'Each agent runs in its own process. Agents not installed on the host',
      'are skipped with a warning. The command waits for all agents to finish',
      'and reports per-agent outcomes (success / failed / skipped / cancelled).',
      '',
      'Flags:',
      '  --timeout <sec>      Per-agent hard timeout (default 300s).',
      '  --concurrency <n>    Max agents running at once (default 4).',
      '',
      'Use /acp list (or wstack acp list) to see which agents are detected.',
    ].join('\n'),
    async run(args) {
      // Pull optional flags out first so they don't get parsed into the agent
      // CSV or the task text. The ensemble engine already supports per-agent
      // timeout and bounded concurrency — these flags just surface them.
      let timeoutMs: number | undefined;
      let maxConcurrency: number | undefined;
      const flagStripped = args
        .replace(/--timeout(?:=|\s+)(\d+)/i, (_m, n: string) => {
          const sec = Number.parseInt(n, 10);
          if (Number.isFinite(sec) && sec > 0) timeoutMs = Math.min(3600, sec) * 1000;
          return ' ';
        })
        .replace(/--(?:concurrency|max)(?:=|\s+)(\d+)/i, (_m, n: string) => {
          const c = Number.parseInt(n, 10);
          if (Number.isFinite(c) && c > 0) maxConcurrency = Math.min(16, c);
          return ' ';
        });
      const trimmed = flagStripped.trim();
      if (!trimmed) {
        return {
          message:
            'Usage: /ensemble <agent-ids-csv> <task description>\n\nExamples:\n  /ensemble claude-code,gemini-cli "review this diff"\n  /ensemble claude-code,codex-cli "refactor auth/session.ts"\n\nRun `wstack acp list` to see which agents are detected on this host.',
        };
      }
      // First token (up to first whitespace) is the comma-separated agent list;
      // the rest is the task description.
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) {
        return {
          message:
            'Task description is required.\n\nUsage: /ensemble <agent-ids-csv> <task description>\nExample: /ensemble claude-code,gemini-cli "explain this code"',
        };
      }
      const agentIds = trimmed.slice(0, spaceIdx);
      const task = stripSurroundingQuotes(trimmed.slice(spaceIdx + 1).trim());
      if (!task) {
        return { message: 'Task description is required.' };
      }

      try {
        const result = await runEnsemble({
          agentIds,
          task,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
        });
        return { message: renderEnsembleText(result) };
      } catch (err) {
        return { message: `Ensemble failed: ${toErrorMessage(err)}` };
      }
    },
  };
}

/**
 * Strip a matched pair of surrounding quote characters (" or ') from a string.
 * The /ensemble usage docs show quoted task strings (e.g. `/ensemble
 * claude-code "review this diff"`); users naturally type the quotes and
 * would be confused if the literal `"` characters ended up in the task.
 */
function stripSurroundingQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return s.slice(1, -1);
  }
  return s;
}

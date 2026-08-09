import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { PhaseGraph, PhaseProgress } from '@wrongstack/core/goal';
import { PhaseStore } from '@wrongstack/core/goal';
import type { SlashCommand } from '@wrongstack/core/types';
import { ConfigError } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';

function getStore(opts: SlashCommandContext): PhaseStore {
  // Engine checkpoints live apart from the canonical mission goal.json file.
  if (!opts.paths)
    throw new ConfigError({
      message: 'PhaseStore not available — paths not configured.',
      code: 'CONFIG_INVALID',
      context: { missing: 'paths' },
    });
  return new PhaseStore({
    baseDir: opts.paths.projectAutophase,
    legacyBaseDirs: [opts.paths.projectGoal],
  });
}

function formatProgress(p: PhaseProgress): string {
  const filled = Math.floor(p.percentComplete / 5);
  const bars = '█'.repeat(filled) + '░'.repeat(20 - filled);
  return [
    `\n  📊 Progress: ${bars} ${p.percentComplete}%`,
    `  📋 Phases: ${p.completed}/${p.totalPhases} done, ${p.running} running, ${p.pending} pending`,
    `  ✅ Tasks: ${p.completedTasks}/${p.totalTasks} completed`,
    `  ⏱  Est: ${p.estimatedHours.toFixed(1)}h | Actual: ${p.actualHours.toFixed(1)}h`,
  ].join('\n');
}

const STATUS_EMOJI: Record<string, string> = {
  pending: '⏳',
  ready: '🔜',
  running: '🔄',
  paused: '⏸',
  completed: '✅',
  failed: '❌',
  skipped: '⏭',
};

function formatPhaseList(graph: PhaseGraph): string {
  const phases = Array.from(graph.phases.values());
  return [
    '',
    'Phases:',
    ...phases.map((p) => {
      const total = p.taskGraph.nodes.size;
      const done = Array.from(p.taskGraph.nodes.values()).filter(
        (t) => t.status === 'completed',
      ).length;
      const tasks = total > 0 ? ` (${done}/${total} todos)` : '';
      return `  ${STATUS_EMOJI[p.status] ?? '?'} ${p.name}: ${p.status}${tasks}`;
    }),
  ].join('\n');
}

/** Best-effort project context to help the planner produce a relevant plan. */
async function gatherProjectContext(projectRoot: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const parts = [
      `Project: ${String(pkg.name ?? 'unknown')}`,
      pkg.description ? `Description: ${String(pkg.description)}` : '',
    ].filter(Boolean);
    return parts.join('\n') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the /goal slash command.
 *
 * Goal turns a free-text goal into a real, LLM-driven build: the host
 * plans phases (each holding many todos), persists the phase-graph as
 * per-project JSON under ~/.wrongstack/projects/<slug>/autophase, and drives
 * the orchestrator — one subagent per task — in the background. Live progress
 * is shown in the TUI PhaseMonitor.
 */
export function buildGoalCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'goal',
    category: 'Agent',
    description:
      'Autonomous phase-based workflow — plans a project into phases of todos and builds it with the LLM.',
    help: [
      'Usage:',
      '  /goal                 Show current status',
      '  /goal start <goal>    Plan + start an autonomous phase build',
      '  /goal pause           Pause (in-flight tasks finish, no new ones start)',
      '  /goal resume          Resume a paused run',
      '  /goal stop            Stop and abort in-flight tasks',
      '  /goal save            Persist current graph to disk',
      '  /goal load [title]    Load a persisted graph (display only)',
      '  /goal list            List saved projects',
      '',
    ].join('\n'),
    async run(args) {
      const { cmd, rest } = parseSubcommand(args);
      const sub = cmd || 'status';
      const store = getStore(opts);

      switch (sub) {
        case 'start': {
          const goal = rest.join(' ').trim();
          if (!goal) {
            return { message: 'Usage: /goal start <goal>  — describe what to build.' };
          }
          if (!opts.onGoalStart) {
            return {
              message: '❌ Goal is not available in this session (no LLM host wired).',
            };
          }

          const projectContext = await gatherProjectContext(opts.projectRoot);
          const result = await opts.onGoalStart({ goal, projectContext });
          if (!result.ok) {
            return { message: `❌ ${result.error}` };
          }

          return {
            message: [
              `🚀 Goal started: **${result.graph.title}**`,
              formatPhaseList(result.graph),
              '',
              'Building autonomously in the background — one subagent per todo.',
              'Use `/goal` for status, `/goal pause` to hold, `/goal stop` to abort.',
            ].join('\n'),
            metadata: { goalInit: { title: result.graph.title } },
          };
        }

        case 'pause': {
          if (!opts.onGoalPause) return { message: '❌ Goal host not available.' };
          opts.onGoalPause();
          return {
            message: '⏸️ Goal paused — running tasks will finish; no new ones will start.',
          };
        }

        case 'resume': {
          if (!opts.onGoalResume) return { message: '❌ Goal host not available.' };
          opts.onGoalResume();
          return { message: '▶ Goal resuming.' };
        }

        case 'stop': {
          if (!opts.onGoalStop) return { message: '❌ Goal host not available.' };
          opts.onGoalStop();
          return { message: '⏹ Goal stopped — in-flight tasks aborted, progress saved.' };
        }

        case 'save': {
          const view = opts.getGoalRunner?.();
          if (!view) return { message: '❌ No active Goal to save.' };
          await store.save(view.graph);
          return { message: `💾 Goal saved: ${view.graph.title}` };
        }

        case 'load': {
          const parts = rest.join(' ').trim();
          const resumeFlag = parts.startsWith('--resume');
          const title = resumeFlag ? parts.replace(/^--resume\s*/, '').trim() : parts;
          const graphs = await store.list();
          if (graphs.length === 0) return { message: '❌ No saved projects.' };
          const entry = title
            ? graphs.find((g) => g.title.toLowerCase().includes(title.toLowerCase()))
            : graphs[0];
          if (!entry) return { message: `❌ No saved project matching "${title}".` };
          const graph = await store.load(entry.id);
          if (!graph) return { message: `❌ Could not load project "${entry.title}".` };

          if (resumeFlag) {
            if (!opts.onGoalResumeFromGraph) {
              return {
                message: [
                  `📂 Loaded with --resume: **${graph.title}**`,
                  '⚠️ Goal resume requires a running CLI host with `onGoalResumeFromGraph` configured.',
                  '',
                  formatPhaseList(graph),
                ].join('\n'),
              };
            }
            await opts.onGoalResumeFromGraph(graph);
            return {
              message: [`▶ Resumed: **${graph.title}**`, formatPhaseList(graph)].join('\n'),
            };
          }

          return {
            message: [`📂 Loaded (display only): **${graph.title}**`, formatPhaseList(graph)].join(
              '\n',
            ),
          };
        }

        case 'list': {
          const graphs = await store.list();
          if (graphs.length === 0) return { message: 'No saved projects.' };
          return {
            message: [
              'Saved Goal projects:',
              ...graphs.map(
                (g) =>
                  `  · ${g.title} — ${g.status} (updated ${new Date(g.updatedAt).toLocaleString()})`,
              ),
            ].join('\n'),
          };
        }

        case 'default':
        case 'status': {
          const view = opts.getGoalRunner?.();
          if (!view) {
            return { message: 'No active Goal. Run `/goal start <goal>` to begin.' };
          }
          const progress = view.getProgress();
          return {
            message: [
              `**${view.graph.title}** ${view.isRunning() ? '🔄 running' : '⏸ idle'}`,
              formatPhaseList(view.graph),
              ...(progress ? [formatProgress(progress)] : []),
            ].join('\n'),
          };
        }
      }
      return {
        message: unknownSubcommand(
          sub,
          ['start', 'pause', 'resume', 'stop', 'save', 'load', 'list', 'status'],
          'goal',
        ),
      };
    },
  };
}

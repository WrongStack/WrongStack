import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand, Usage } from '@wrongstack/contracts/types';
import { ConfigError } from '@wrongstack/contracts/types';
import { buildGoalPreamble } from '@wrongstack/core/execution';
import type { GoalFile, PhaseGraph, PhaseProgress } from '@wrongstack/goal';
import {
  formatGoal,
  loadGoal,
  PhaseStore,
  replaceGoalMission,
  saveGoal,
  updateGoal,
} from '@wrongstack/goal';
import type { SlashCommandContext } from './command-context.js';
import { refineGoalWithFallback, resolveRefinerTarget } from './goal-refiner.js';
import { buildGoalsCommand } from './goals.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';

/**
 * Best-effort: journal goal-refinement spend into the session cost pipeline.
 * Closed-session append failures are intentionally dropped — the refine
 * confirmation must not depend on journaling.
 */
function journalGoalRefineUsage(
  opts: SlashCommandContext,
  usage: Usage,
  source: { providerId: string; model: string },
): void {
  const session = opts.context?.session;
  if (!session) return;
  void session
    .append({
      type: 'enhance_usage',
      ts: new Date().toISOString(),
      usage,
      provider: source.providerId,
      model: source.model,
    })
    .catch(() => {
      // Session journaling is best-effort by contract.
    });
}

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
  });
}

const MISSION_COMMANDS = new Set(['set', 'new', 'refine', 'clear', 'journal', 'log']);

async function runMissionCommand(
  opts: SlashCommandContext,
  args: string,
): Promise<{ message?: string | undefined; runText?: string | undefined }> {
  if (!opts.paths) return { message: 'Goal mission storage is not configured.' };
  const [verbRaw, ...rest] = args.trim().split(/\s+/);
  const verb = (verbRaw || 'status').toLowerCase();
  const text = rest.join(' ').trim();
  const goalPath = opts.paths.projectGoal;

  if (verb === 'status' || verb === 'show') {
    const current = await loadGoal(goalPath, opts.events);
    return {
      message: current
        ? formatGoal(current)
        : 'No persistent mission set. Use `/goal set <mission>` or `/goal start <goal>`.',
    };
  }

  if (verb === 'set' || verb === 'new') {
    if (!text) return { message: 'Usage: /goal set <mission>' };
    const cfg = opts.configStore?.get();
    const refinerTarget =
      cfg && opts.createProvider
        ? resolveRefinerTarget(cfg, opts.createProvider, cfg.provider ?? '', cfg.model ?? '')
        : undefined;
    const refined = await refineGoalWithFallback(text, {
      primaryProvider: opts.llmProvider,
      primaryModel: opts.llmModel,
      refinerProvider: refinerTarget?.provider,
      refinerModel: refinerTarget?.model,
      onUsage: (usage, source) => journalGoalRefineUsage(opts, usage, source),
    });
    let next: GoalFile | undefined;
    await updateGoal(
      goalPath,
      (current) => {
        next = replaceGoalMission(current, text, refined);
        return next;
      },
      opts.events,
    );
    return {
      message: `🎯 Mission set: ${refined.refinedGoal}\n\n${formatGoal(next!, 0)}`,
      runText: buildGoalPreamble(refined.refinedGoal, refined.deliverables),
    };
  }

  if (verb === 'refine') {
    const current = await loadGoal(goalPath, opts.events);
    if (!current) return { message: 'No persistent mission to refine.' };
    const cfg = opts.configStore?.get();
    const refinerTarget =
      cfg && opts.createProvider
        ? resolveRefinerTarget(cfg, opts.createProvider, cfg.provider ?? '', cfg.model ?? '')
        : undefined;
    const refined = await refineGoalWithFallback(current.goal, {
      primaryProvider: opts.llmProvider,
      primaryModel: opts.llmModel,
      refinerProvider: refinerTarget?.provider,
      refinerModel: refinerTarget?.model,
      onUsage: (usage, source) => journalGoalRefineUsage(opts, usage, source),
    });
    // Apply onto the file as it is NOW, under its lock: the refine awaited an
    // LLM, and saving the snapshot loaded before it dropped every journal
    // entry, attempt count and engine state the eternal loop wrote meanwhile.
    let updated: GoalFile | undefined;
    await updateGoal(
      goalPath,
      (latest) => {
        if (!latest || latest.goal !== current.goal) return latest;
        updated = {
          ...latest,
          refinedGoal: refined.refinedGoal,
          deliverables: refined.deliverables,
        };
        return updated;
      },
      opts.events,
    );
    if (!updated)
      return { message: 'The mission changed while it was being refined; nothing was applied.' };
    return { message: `✓ Mission refined.\n\n${formatGoal(updated)}` };
  }

  if (verb === 'clear') {
    const current = await loadGoal(goalPath, opts.events);
    if (!current) return { message: 'No persistent mission to clear.' };
    opts.onEternalStop?.();
    await fsp.unlink(goalPath).catch(() => undefined);
    return { message: 'Mission cleared and the eternal loop stopped.' };
  }

  if (verb === 'journal' || verb === 'log') {
    const current = await loadGoal(goalPath, opts.events);
    if (!current) return { message: 'No persistent mission set.' };
    const count = Math.min(500, Math.max(1, Number.parseInt(text || '25', 10) || 25));
    const rows = current.journal.slice(-count);
    return {
      message:
        rows.length === 0
          ? 'Mission journal is empty.'
          : rows.map((entry) => `#${entry.iteration} [${entry.status}] ${entry.task}`).join('\n'),
    };
  }

  if (verb === 'pause' || verb === 'resume') {
    const current = await loadGoal(goalPath, opts.events);
    if (!current) return { message: `No persistent mission to ${verb}.` };
    if (verb === 'pause') {
      if (current.goalState === 'paused') return { message: 'Mission is already paused.' };
      await saveGoal(goalPath, { ...current, goalState: 'paused' }, opts.events);
      return { message: 'Mission paused; the current eternal iteration may finish first.' };
    }
    if (current.goalState !== 'paused') return { message: 'Mission is not paused.' };
    await saveGoal(goalPath, { ...current, goalState: 'active' }, opts.events);
    return { message: 'Mission resumed.' };
  }

  return { message: `Unknown mission command: ${verb}` };
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
      '  /goal set <mission>   Set the persistent eternal/parallel mission',
      '  /goal start <goal>    Plan + start an autonomous phase build',
      '  /goal pause           Pause (in-flight tasks finish, no new ones start)',
      '  /goal resume          Resume a paused run',
      '  /goal stop            Stop and abort in-flight tasks',
      '  /goal save            Persist current graph to disk',
      '  /goal load [title]    Load a persisted graph (display only)',
      '  /goal list            List saved projects',
      '  /goal clear           Clear the persistent mission',
      '  /goal journal [N]     Show persistent mission activity',
      '',
    ].join('\n'),
    async run(args) {
      const raw = args.trim();
      const [firstRaw, ...tail] = raw.split(/\s+/);
      const first = (firstRaw ?? '').toLowerCase();
      if (first === 'status' && tail.length > 0) return buildGoalsCommand(opts).run(tail.join(' '));
      if (first === 'mission') return runMissionCommand(opts, tail.join(' '));
      if (MISSION_COMMANDS.has(first)) return runMissionCommand(opts, raw);
      const phaseCommands = new Set([
        'start',
        'pause',
        'resume',
        'stop',
        'save',
        'load',
        'list',
        'status',
      ]);
      if (first && !phaseCommands.has(first)) return runMissionCommand(opts, `set ${raw}`);

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
            metadata: { goalRunInit: { title: `${result.graph.title} [${result.graph.id}]` } },
          };
        }

        case 'pause': {
          if (!opts.getGoalRunner?.()) return runMissionCommand(opts, 'pause');
          if (!opts.onGoalPause) return { message: '❌ Goal host not available.' };
          opts.onGoalPause();
          return {
            message: '⏸️ Goal paused — running tasks will finish; no new ones will start.',
          };
        }

        case 'resume': {
          if (!opts.getGoalRunner?.()) return runMissionCommand(opts, 'resume');
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
            const resumed = await opts.onGoalResumeFromGraph(graph);
            if (!resumed.ok) return { message: `❌ ${resumed.error}` };
            return {
              message: [`▶ Resumed: **${graph.title}**`, formatPhaseList(graph)].join('\n'),
              metadata: { goalRunInit: { title: graph.title } },
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
            return runMissionCommand(opts, 'status');
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

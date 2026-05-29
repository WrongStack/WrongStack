import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand, PhaseGraph, PhaseProgress } from '@wrongstack/core';
import { PhaseStore } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

function getStore(opts: SlashCommandContext): PhaseStore {
  // Per-project: ~/.wrongstack/projects/<hash>/autophase
  return new PhaseStore({ baseDir: opts.paths.projectAutophase });
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
      const done = Array.from(p.taskGraph.nodes.values()).filter((t) => t.status === 'completed').length;
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
 * Build the /autophase slash command.
 *
 * AutoPhase turns a free-text goal into a real, LLM-driven build: the host
 * plans phases (each holding many todos), persists the phase-graph as
 * per-project JSON under ~/.wrongstack/projects/<hash>/autophase, and drives
 * the orchestrator — one subagent per task — in the background. Live progress
 * is shown in the TUI PhaseMonitor.
 */
export function buildAutoPhaseCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'autophase',
    description: 'Autonomous phase-based workflow — plans a project into phases of todos and builds it with the LLM.',
    help: [
      'Usage:',
      '  /autophase                 Show current status',
      '  /autophase start <goal>    Plan + start an autonomous phase build',
      '  /autophase pause           Pause (in-flight tasks finish, no new ones start)',
      '  /autophase resume          Resume a paused run',
      '  /autophase stop            Stop and abort in-flight tasks',
      '  /autophase save            Persist current graph to disk',
      '  /autophase load [title]    Load a persisted graph (display only)',
      '  /autophase list            List saved projects',
      '',
    ].join('\n'),
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? 'status';
      const store = getStore(opts);

      switch (sub) {
        case 'start': {
          const goal = parts.slice(1).join(' ').trim();
          if (!goal) {
            return { message: 'Usage: /autophase start <goal>  — describe what to build.' };
          }
          if (!opts.onAutoPhaseStart) {
            return { message: '❌ AutoPhase is not available in this session (no LLM host wired).' };
          }

          const projectContext = await gatherProjectContext(opts.projectRoot);
          const result = await opts.onAutoPhaseStart({ goal, projectContext });
          if (!result.ok) {
            return { message: `❌ ${result.error}` };
          }

          return {
            message: [
              `🚀 AutoPhase started: **${result.graph.title}**`,
              formatPhaseList(result.graph),
              '',
              'Building autonomously in the background — one subagent per todo.',
              'Use `/autophase` for status, `/autophase pause` to hold, `/autophase stop` to abort.',
            ].join('\n'),
          };
        }

        case 'pause': {
          if (!opts.onAutoPhasePause) return { message: '❌ AutoPhase host not available.' };
          opts.onAutoPhasePause();
          return { message: '⏸️ AutoPhase paused — running tasks will finish; no new ones will start.' };
        }

        case 'resume': {
          if (!opts.onAutoPhaseResume) return { message: '❌ AutoPhase host not available.' };
          opts.onAutoPhaseResume();
          return { message: '▶ AutoPhase resuming.' };
        }

        case 'stop': {
          if (!opts.onAutoPhaseStop) return { message: '❌ AutoPhase host not available.' };
          opts.onAutoPhaseStop();
          return { message: '⏹ AutoPhase stopped — in-flight tasks aborted, progress saved.' };
        }

        case 'save': {
          const view = opts.getAutoPhaseRunner?.();
          if (!view) return { message: '❌ No active AutoPhase to save.' };
          await store.save(view.graph);
          return { message: `💾 AutoPhase saved: ${view.graph.title}` };
        }

        case 'load': {
          const title = parts.slice(1).join(' ').trim();
          const graphs = await store.list();
          if (graphs.length === 0) return { message: '❌ No saved projects.' };
          const entry = title
            ? graphs.find((g) => g.title.toLowerCase().includes(title.toLowerCase()))
            : graphs[0];
          if (!entry) return { message: `❌ No saved project matching "${title}".` };
          const graph = await store.load(entry.id);
          if (!graph) return { message: `❌ Could not load project "${entry.title}".` };
          return {
            message: [`📂 Loaded (display only): **${graph.title}**`, formatPhaseList(graph)].join('\n'),
          };
        }

        case 'list': {
          const graphs = await store.list();
          if (graphs.length === 0) return { message: 'No saved projects.' };
          return {
            message: [
              'Saved AutoPhase projects:',
              ...graphs.map((g) => `  · ${g.title} — ${g.status} (updated ${new Date(g.updatedAt).toLocaleString()})`),
            ].join('\n'),
          };
        }

        default:
        case 'status': {
          const view = opts.getAutoPhaseRunner?.();
          if (!view) {
            return { message: 'No active AutoPhase. Run `/autophase start <goal>` to begin.' };
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
    },
  };
}

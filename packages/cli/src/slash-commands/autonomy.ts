import { goalFilePath, loadGoal, summarizeUsage } from '@wrongstack/core/goal';
import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { AutonomyMode } from '../services/autonomy-mode.js';
import type { SlashCommandContext } from './command-context.js';

export type { AutonomyMode } from '../services/autonomy-mode.js';

const MODE_LABELS: Record<AutonomyMode, string> = {
  off: `${color.green('OFF')} ${color.dim('(agent stops after each turn)')}`,
  suggest: `${color.cyan('SUGGEST')} ${color.dim('(shows next-step suggestions)')}`,
  auto: `${color.yellow('AUTO')} ${color.dim('(self-driving — Esc to redirect, Ctrl+C to stop)')}`,
  eternal: `${color.red('ETERNAL')} ${color.dim('(goal-driven loop — YOLO, until /autonomy stop)')}`,
  'eternal-parallel': `${color.magenta('PARALLEL')} ${color.dim('(4-8 subagents per tick — fan-out, until /autonomy stop)')}`,
};

const MODE_LABELS_SHORT: Record<AutonomyMode, string> = {
  off: `${color.green('OFF')} — agent stops after each turn`,
  suggest: `${color.cyan('SUGGEST')} — shows next-step suggestions after each turn`,
  auto: `${color.yellow('AUTO')} — self-driving, agent continues automatically`,
  eternal: `${color.red('ETERNAL')} — goal-driven sittin-sene loop`,
  'eternal-parallel': `${color.magenta('PARALLEL')} — fan-out 4-8 subagents per tick`,
};

export function buildAutonomyCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'autonomy',
    category: 'Agent',
    description: 'Toggle or query autonomy mode (self-driving agent).',
    help: [
      'Usage:',
      '  /autonomy            Show current autonomy status',
      '  /autonomy off        Disabled — agent stops after each turn (default)',
      '  /autonomy suggest    Show next-step suggestions after each turn',
      '  /autonomy on         Auto-continue — agent picks next step and proceeds',
      '  /autonomy eternal    Goal-driven loop — runs forever against /goal',
      '                       (prompts to confirm an existing goal; `--keep` to skip prompt)',
      '  /autonomy parallel   Parallel mode — 4-8 agents per tick, fan-out parallelism',
      '                       (prompts to confirm an existing goal; `--keep` to skip prompt)',
      '  /autonomy stop       Stop eternal mode (no-op for other modes)',
      '  /autonomy toggle     Cycle: off → suggest → auto → eternal → parallel → off',
      '',
      'Modes:',
      '  off      — Normal interactive mode. Agent stops and waits.',
      '  suggest  — After each turn, agent suggests next steps. You pick.',
      '  auto     — After each turn, agent picks the best next step and continues.',
      '             Runs indefinitely until you press Esc or Ctrl+C.',
      '  eternal  — Goal-driven sense/decide/execute/reflect loop. Requires /goal.',
      '             Force-enables YOLO; tool calls run without approval unless',
      '             an explicit deny rule blocks them. Runs until /autonomy stop or Ctrl+C twice.',
      '  parallel — Fan-out 4–8 subagents per tick. Each tick decomposes the goal,',
      '             spawns N agents, awaits results, aggregates. Requires /goal.',
      '             Force-enables YOLO; tool calls run without approval unless',
      '             an explicit deny rule blocks them. Runs until /autonomy stop or Ctrl+C twice.',
      '',
      'Eternal stage flow: decide → execute → reflect → sleep | paused | stopped',
      'Stage shown in real-time. Use /goal pause to pause, /goal resume to continue.',
      '',
      'In auto/eternal/parallel modes the agent works autonomously. Press Esc to redirect,',
      'Ctrl+C to stop the active iteration. /autonomy stop ends the eternal loop.',
    ].join('\n'),
    async run(args) {
      // First token is the action; everything after it is treated as
      // modifiers (e.g. `eternal --keep`, `parallel --new`). Pre-split so
      // both halves are available throughout the dispatch.
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const arg = parts[0] ?? '';
      const modifiers = parts.slice(1);

      if (!opts.onAutonomy) {
        const msg = 'Autonomy mode is not available in this session.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      // No argument — show current status (mode + engine + goal snapshot)
      if (!arg || arg === 'status') {
        const current = opts.onAutonomy();
        const lines: string[] = [`Autonomy mode: ${MODE_LABELS[current] ?? current}`];
        try {
          const goal = await loadGoal(goalFilePath(opts.projectRoot), opts.events);
          if (goal) {
            const u = summarizeUsage(goal);
            lines.push(
              color.dim(
                `  Goal: ${goal.goal.length > 80 ? `${goal.goal.slice(0, 77)}…` : goal.goal}`,
              ),
            );
            lines.push(
              color.dim(
                `  Engine state: ${goal.engineState}  ·  iterations: ${goal.iterations}  ·  journal: ${goal.journal.length}`,
              ),
            );
            if (u.iterationsWithUsage > 0) {
              lines.push(
                color.dim(
                  `  Spent: $${u.totalCostUsd.toFixed(4)}  ·  ${u.totalInputTokens} in / ${u.totalOutputTokens} out tokens`,
                ),
              );
            }
            const recent = goal.journal.slice(-10);
            const failed = recent.filter((e) => e.status === 'failure').length;
            if (failed > 0) {
              lines.push(
                color.amber(`  Recent failures: ${failed} of last ${recent.length} iterations`),
              );
            }
          }
        } catch {
          // best-effort; suppress
        }
        const msg = lines.join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      // Stop is a separate action, not a mode set.
      if (arg === 'stop' || arg === 'halt' || arg === 'kill') {
        if (!opts.onEternalStop) {
          const msg = 'No eternal-mode controller wired in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        // Stop both engines if they're running
        opts.getEternalEngine?.()?.stop();
        opts.getParallelEngine?.()?.stop();
        opts.onEternalStop();
        opts.onAutonomy('off');
        let summaryLine = '';
        try {
          const goal = await loadGoal(goalFilePath(opts.projectRoot), opts.events);
          if (goal) {
            const u = summarizeUsage(goal);
            if (u.iterationsWithUsage > 0) {
              summaryLine =
                '\n' +
                color.dim(
                  `  Spent so far: $${u.totalCostUsd.toFixed(4)} · ${u.totalInputTokens} in / ${u.totalOutputTokens} out tokens · ${goal.iterations} total iterations.`,
                );
            } else if (goal.iterations > 0) {
              summaryLine = '\n' + color.dim(`  Total iterations: ${goal.iterations}.`);
            }
          }
        } catch {
          // best-effort
        }
        const msg = `${color.amber('Eternal/parallel mode stop requested.')} In-flight eternal work is cancelled; parallel fan-out stops after the current tick cleans up.${summaryLine}`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      // Explicit set
      let newMode: AutonomyMode;
      if (arg === 'on' || arg === 'enable' || arg === 'true' || arg === 'auto') {
        newMode = 'auto';
      } else if (arg === 'off' || arg === 'disable' || arg === 'false') {
        newMode = 'off';
      } else if (arg === 'suggest' || arg === 'suggestions') {
        newMode = 'suggest';
      } else if (
        arg === 'eternal' ||
        arg === 'forever' ||
        arg === 'infinite' ||
        arg === 'sittinsene'
      ) {
        newMode = 'eternal';
      } else if (arg === 'parallel' || arg === 'eternal-parallel' || arg === 'fanout') {
        newMode = 'eternal-parallel';
      } else if (arg === 'toggle' || arg === 'cycle') {
        const current = opts.onAutonomy() ?? 'off';
        const cycle: AutonomyMode[] = ['off', 'suggest', 'auto', 'eternal', 'eternal-parallel'];
        newMode = cycle[(cycle.indexOf(current) + 1) % cycle.length] ?? 'off';
      } else {
        const msg = `Unknown argument: ${arg}. Use /autonomy on, off, suggest, eternal, parallel, stop, or toggle.`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      // Both eternal and parallel modes require a goal.
      if (newMode === 'eternal' || newMode === 'eternal-parallel') {
        // Honor explicit short-circuits: `--keep` skips the confirm,
        // `--new` aborts with instructions to reset the goal first.
        const wantKeep = modifiers.includes('--keep') || modifiers.includes('keep');
        const wantNew = modifiers.includes('--new') || modifiers.includes('new');

        const goal = await loadGoal(goalFilePath(opts.projectRoot), opts.events);
        if (!goal) {
          const msg = `${color.red('Eternal/parallel mode requires a goal.')} Run \`/goal set <mission>\` first.`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }

        if (wantNew) {
          const msg =
            `${color.amber('New mission requested.')} Clear the current goal first: ${color.bold('/goal clear')}, ` +
            `then ${color.bold('/goal set <mission>')}, then re-run ${color.bold(`/autonomy ${newMode}`)}.`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }

        const isStale = goal.iterations > 0 || goal.engineState === 'running';

        // Existing goal — confirm before launching so an old mission
        // doesn't get reanimated unintentionally. `--keep` bypasses the
        // prompt. When the host didn't wire a `confirm` callback (tests,
        // non-TTY), fall back to the old behaviour: launch if fresh,
        // hard-error if stale.
        if (!wantKeep) {
          if (opts.confirm) {
            const goalPreview = goal.goal.length > 80 ? `${goal.goal.slice(0, 77)}…` : goal.goal;
            const detail = isStale
              ? `${color.amber('Stale goal')} (${goal.iterations} iterations, engineState: ${goal.engineState}): "${goalPreview}". Continue with this mission?`
              : `Existing goal: "${goalPreview}". Use this mission?`;
            const defaultYes = !isStale;
            const answer = await opts.confirm(detail, defaultYes);
            if (answer === null) {
              const msg = `${color.dim('Cancelled.')} Autonomy mode unchanged.`;
              opts.renderer.write(msg);
              return { message: msg };
            }
            if (!answer) {
              const msg =
                `${color.amber('Skipped.')} To start a new mission: ${color.bold('/goal clear')} → ` +
                `${color.bold('/goal set <mission>')} → ${color.bold(`/autonomy ${newMode}`)}. ` +
                `To force the existing one: ${color.bold(`/autonomy ${newMode} --keep`)}.`;
              opts.renderer.write(msg);
              return { message: msg };
            }
          } else if (isStale) {
            // No confirm callback — keep the pre-prompt behaviour so the
            // engine never auto-resumes a stale mission in non-interactive
            // contexts. Tests rely on this path.
            const msg =
              `${color.amber('Stale goal detected.')} Previous mission has ${goal.iterations} iterations ` +
              `(engineState: ${goal.engineState}). Clear it first: ${color.bold('/goal clear')}, ` +
              `then set a new one: ${color.bold('/goal set <mission>')}.`;
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
        }

        if (!opts.onEternalStart) {
          const msg = 'Eternal mode controller is not wired in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        if (opts.onYolo) opts.onYolo(true);
        opts.onAutonomy(newMode);
        opts.onEternalStart(newMode);
        const modeLabel =
          newMode === 'eternal-parallel'
            ? `${color.magenta('PARALLEL')} mode`
            : `${color.red('ETERNAL')} mode`;
        const msg =
          `Autonomy mode: ${modeLabel} — engine launching against goal: ${color.bold(goal.goal)}\n` +
          `${color.dim('YOLO enabled; tool calls run without approval unless an explicit deny rule blocks them. Use /autonomy stop to end. Journal at /goal journal.')}`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      // Stop any running eternal/parallel engine when switching modes.
      const previous = opts.onAutonomy() as AutonomyMode;
      if ((previous === 'eternal' || previous === 'eternal-parallel') && opts.onEternalStop) {
        opts.onEternalStop();
      }

      opts.onAutonomy(newMode);
      const msg = `Autonomy mode: ${MODE_LABELS_SHORT[newMode]}`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}

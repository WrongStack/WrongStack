import type { SlashCommand } from '@wrongstack/core';
import {
  buildGoalPreamble,
  color,
  emptyGoal,
  formatGoal,
  type GoalFile,
  loadGoal,
  saveGoal,
} from '@wrongstack/core';
import { type RefinedGoal, refineGoal, refineGoalHeuristic } from './goal-refiner.js';
import type { SlashCommandContext } from './index.js';

const KNOWN_VERBS = new Set([
  '',
  'show',
  'status',
  'set',
  'new',
  'clear',
  'reset',
  'journal',
  'log',
  'pause',
  'resume',
  'refine',
]);

export function buildGoalCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'goal',
    category: 'Agent',
    description:
      'Set, inspect, or clear the long-running autonomous mission. Auto-refines goals for clarity.',
    help: [
      'Usage:',
      '  /goal                     Show current goal + progress + recent journal',
      '  /goal set <text>          Set a new goal (auto-refined for clarity)',
      '  /goal refine              Re-refine the current goal',
      '  /goal clear               Clear the goal (stops eternal mode if running)',
      '  /goal pause               Pause at end of current iteration',
      '  /goal resume              Resume a paused goal',
      '  /goal journal [N]         Show last N journal entries (default 25)',
      '',
      'When a goal is set, WrongStack auto-refines it using the LLM to:',
      '  • Make it unambiguous and concrete',
      '  • Extract verifiable deliverables with acceptance criteria',
      '  • Estimate completion progress (shown as a progress bar)',
      '',
      'Stage flow: decide → execute → reflect → sleep | paused | stopped',
      'The engine updates progress after each iteration toward the deliverable list.',
      '',
      'Goals live in ~/.wrongstack/projects/<hash>/goal.json and persist across sessions.',
      'A goal is the prerequisite for /autonomy eternal — the engine consults it on',
      'every iteration to decide what to do next.',
    ].join('\n'),
    async run(args) {
      // TUI mode: bare /goal opens the goal panel.
      if (!args.trim() && opts.onPanelOpen?.current) {
        const opened = opts.onPanelOpen.current('toggleGoalPanel');
        if (opened) return { message: '' };
      }
      const trimmed = args.trim();
      const [verbRaw, ...rest] = trimmed.split(/\s+/);
      const verb = (verbRaw ?? '').toLowerCase();
      const restJoined = rest.join(' ').trim();
      if (!opts.paths) return { message: 'Goal not available — paths not configured.' };
      const goalPath = opts.paths.projectGoal;

      // If the first token isn't a known verb, treat the entire args
      // string as the goal text — `/goal rewrite the auth module` works.
      const verbForDispatch = verb && !KNOWN_VERBS.has(verb) ? 'set' : verb;
      const setText = verbForDispatch === 'set' && !KNOWN_VERBS.has(verb) ? trimmed : restJoined;

      switch (verbForDispatch) {
        case '':
        case 'show':
        case 'status': {
          const current = await loadGoal(goalPath, opts.events);
          if (!current) {
            const msg = 'No goal set. Use `/goal set <mission text>` to create one.';
            opts.renderer.write(msg);
            return { message: msg };
          }
          const msg = formatGoal(current);
          opts.renderer.write(msg);
          return { message: msg };
        }

        case 'set':
        case 'new': {
          if (!setText) {
            const msg = 'Usage: /goal set <mission text>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }

          // Try LLM refinement
          let refined: RefinedGoal | null = null;
          if (opts.llmProvider && opts.llmModel) {
            opts.renderer.write(color.dim('Refining goal with LLM…'));
            refined = await refineGoal(setText, opts.llmProvider, opts.llmModel);
          }
          if (!refined) {
            refined = refineGoalHeuristic(setText);
          }

          const existing = await loadGoal(goalPath, opts.events);
          const now = new Date().toISOString();
          const next: GoalFile = existing
            ? {
                ...existing,
                goal: setText,
                refinedGoal: refined.refinedGoal,
                deliverables: refined.deliverables,
                setAt: now,
                lastActivityAt: now,
                progress: undefined, // reset progress
                progressNote: undefined,
              }
            : {
                ...emptyGoal(setText),
                refinedGoal: refined.refinedGoal,
                deliverables: refined.deliverables,
              };

          await saveGoal(goalPath, next, opts.events);

          // Show summary
          const lines: string[] = [];
          lines.push(`🎯 ${color.green('Goal locked:')} ${color.bold(refined.refinedGoal)}`);
          if (refined.refinedGoal !== setText) {
            lines.push(
              color.dim(
                `  (original: "${setText.length > 60 ? setText.slice(0, 60) + '…' : setText}")`,
              ),
            );
          }
          if (refined.deliverables.length > 0) {
            lines.push('');
            lines.push(`${color.bold('Deliverables')} (${refined.deliverables.length}):`);
            for (const d of refined.deliverables) {
              lines.push(`  ${color.dim('○')} ${d}`);
            }
          }
          lines.push('');
          lines.push(color.dim(`Stored in ${goalPath} — progress tracked automatically.`));

          const msg = lines.join('\n');
          opts.renderer.write(msg);
          return {
            message: msg,
            runText: buildGoalPreamble(refined.refinedGoal, refined.deliverables),
          };
        }

        case 'refine': {
          const current = await loadGoal(goalPath, opts.events);
          if (!current) {
            const msg = 'No goal set to refine. Use /goal set <text> first.';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }

          let refined: RefinedGoal | null = null;
          if (opts.llmProvider && opts.llmModel) {
            opts.renderer.write(color.dim('Re-refining goal with LLM…'));
            refined = await refineGoal(current.goal, opts.llmProvider, opts.llmModel);
          }
          if (!refined) {
            refined = refineGoalHeuristic(current.goal);
          }

          const updated: GoalFile = {
            ...current,
            refinedGoal: refined.refinedGoal,
            deliverables: refined.deliverables,
          };
          await saveGoal(goalPath, updated, opts.events);

          const msg = `${color.green('✓')} Goal re-refined with ${refined.deliverables.length} deliverables.`;
          opts.renderer.write(msg);
          return { message: `${msg}\n\n${formatGoal(updated)}` };
        }

        case 'clear':
        case 'reset': {
          const current = await loadGoal(goalPath, opts.events);
          if (!current) {
            const msg = 'No goal to clear.';
            opts.renderer.write(msg);
            return { message: msg };
          }
          const abandoned: GoalFile = { ...current, goalState: 'abandoned' };
          await saveGoal(goalPath, abandoned, opts.events);
          const { unlink } = await import('node:fs/promises');
          try {
            await unlink(goalPath);
          } catch {
            // best-effort
          }
          if (opts.onEternalStop) opts.onEternalStop();
          // Flip autonomy back to 'off' so the REPL exits eternal mode.
          // Without this, the REPL keeps spinning in the eternal loop
          // even though the goal file is gone.
          if (opts.onAutonomy) opts.onAutonomy('off');
          const msg = `${color.amber('Goal cleared.')} Previous goal marked abandoned; eternal mode will stop.`;
          opts.renderer.write(msg);
          return { message: msg };
        }

        case 'journal':
        case 'log': {
          const current = await loadGoal(goalPath, opts.events);
          if (!current) {
            const msg = 'No goal set.';
            opts.renderer.write(msg);
            return { message: msg };
          }
          const n = restJoined ? Math.max(1, Number.parseInt(restJoined, 10) || 25) : 25;
          if (current.journal.length === 0) {
            const msg = 'Journal is empty.';
            opts.renderer.write(msg);
            return { message: msg };
          }
          const tail = current.journal.slice(-n);
          const lines = tail.map((e) => {
            const mark =
              e.status === 'success'
                ? color.green('✓')
                : e.status === 'failure'
                  ? color.red('✗')
                  : e.status === 'aborted'
                    ? color.amber('⊘')
                    : color.dim('·');
            const note = e.note ? color.dim(` — ${e.note}`) : '';
            return `${color.dim(`#${e.iteration}`)} ${mark} ${color.dim(`[${e.source}]`)} ${e.task}${note}`;
          });
          const header = `Journal (last ${tail.length} of ${current.journal.length}):`;
          const msg = `${header}\n${lines.join('\n')}`;
          opts.renderer.write(msg);
          return { message: msg };
        }

        case 'pause': {
          const current = await loadGoal(goalPath, opts.events);
          if (!current) {
            const msg = 'No goal set — nothing to pause.';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          if (current.goalState === 'paused') {
            const msg = `${color.dim('Already paused.')} Use /goal resume to continue.`;
            opts.renderer.write(msg);
            return { message: msg };
          }
          const paused: GoalFile = { ...current, goalState: 'paused' };
          await saveGoal(goalPath, paused, opts.events);
          const msg = `${color.cyan('Goal paused.')} Current iteration will finish, then the loop stops. Use /goal resume to continue.`;
          opts.renderer.write(msg);
          return { message: msg };
        }

        case 'resume': {
          const current = await loadGoal(goalPath, opts.events);
          if (!current) {
            const msg = 'No goal set — cannot resume.';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          if (current.goalState !== 'paused') {
            const msg = `${color.dim('Not paused.')} Use /goal set <text> to create or update a goal first.`;
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          const resumed: GoalFile = { ...current, goalState: 'active' };
          await saveGoal(goalPath, resumed, opts.events);
          const msg = `${color.green('Goal resumed.')} Loop will continue from the next iteration.`;
          opts.renderer.write(msg);
          return { message: msg };
        }

        default: {
          const msg = `Unknown subcommand "${verb}". Try: show | set <text> | refine | clear | journal [N]`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
      }
    },
  };
}

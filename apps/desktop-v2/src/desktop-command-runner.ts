import { parseHuntSlashArgs } from '@wrongstack/project-surfaces/lib/bug-hunt-commands';
import {
  BUG_HUNT_MODE_DESCRIPTIONS,
  type BugHuntMode,
} from '@wrongstack/project-surfaces/lib/bug-hunt-message';
import { agentModes } from './AgentModeControl';
import { AUTONOMY_MODES, sessionAutonomy } from './autonomy-model';
import {
  type DesktopCommandContext,
  type DesktopCommandOutcome,
  HANDLED,
  reason,
  refused,
} from './desktop-command-context';
import {
  runBrain,
  runBrowser,
  runDoctor,
  runExport,
  runMcp,
  runNext,
  runSave,
  runTodos,
  runWorkingDir,
} from './desktop-command-engine';
import { parseDesktopCommand } from './desktop-commands';
import { runGoal } from './desktop-goal-command';
import { huntLabel } from './desktop-hunt';

export type { DesktopCommandContext, DesktopCommandOutcome } from './desktop-command-context';

/** This conversation's preferences as the engine last reported them (`prefs.updated`). */
const prefsOf = (context: DesktopCommandContext) => context.state.results['prefs.updated'] ?? {};

const NEXT_STEPS_UNLIMITED = new Set(['unlimited', 'inf', 'infinite', '∞', 'sonsuz', '0']);
const limitText = (limit: number) => (limit <= 0 ? 'unlimited' : `${limit} turns`);

/** Saves a preference patch on this conversation and reports the outcome. */
function savePrefs(context: DesktopCommandContext, patch: Record<string, unknown>, done: string) {
  void context.command('prefs.update', patch, ['key.operation_result']).then(
    () => context.notify(done),
    (error) => context.fail(reason(error)),
  );
}

function runAutonomy(argument: string, context: DesktopCommandContext): DesktopCommandOutcome {
  const modes = AUTONOMY_MODES.map(([id]) => id);
  const wanted = argument.toLowerCase();
  if (!wanted) {
    const current = sessionAutonomy(prefsOf(context)).mode || 'not set';
    context.notify(`Continuation mode: ${current}. Use /autonomy <${modes.join('|')}>.`);
    return HANDLED;
  }
  const mode = modes.find((id) => id === wanted);
  if (!mode) return refused(`Unknown continuation mode “${argument}”. Use ${modes.join(', ')}.`);
  void context.command('autonomy.switch', { mode }, ['key.operation_result']).then(
    () => context.notify(`Continuation mode → ${mode}.`),
    (error) => context.fail(reason(error)),
  );
  return HANDLED;
}

function runMode(argument: string, context: DesktopCommandContext): DesktopCommandOutcome {
  if (!argument) {
    void context.command('modes.list', {}, ['modes.list']).then(
      (reply) => {
        const { modes, activeId } = agentModes(reply);
        const names = ['default', ...modes.map((mode) => mode.id)].map((id) =>
          id === activeId ? `${id} (active)` : id,
        );
        context.notify(`Agent modes: ${names.join(', ')}. Use /mode <id> to switch.`);
      },
      (error) => context.fail(reason(error)),
    );
    return HANDLED;
  }
  void context.command('mode.switch', { id: argument }, ['key.operation_result']).then(
    () => context.notify(`Agent mode → ${argument}.`),
    (error) => context.fail(reason(error)),
  );
  return HANDLED;
}

function runYolo(argument: string, context: DesktopCommandContext): DesktopCommandOutcome {
  const wanted = argument.toLowerCase();
  if (!wanted) {
    const prefs = prefsOf(context);
    const current = prefs['yoloPlus'] === true ? 'YOLO+' : prefs['yolo'] === true ? 'on' : 'off';
    context.notify(`YOLO: ${current}. Use /yolo on, /yolo plus or /yolo off.`);
    return HANDLED;
  }
  if (wanted === 'plus' || wanted === '+' || wanted === 'all')
    savePrefs(
      context,
      { yolo: true, yoloPlus: true },
      'YOLO → YOLO+: every call is allowed and nothing asks. Deny rules still refuse.',
    );
  else if (wanted === 'on')
    savePrefs(context, { yolo: true, yoloPlus: false }, 'YOLO → on: damaging kinds still ask.');
  else if (wanted === 'off')
    savePrefs(
      context,
      { yolo: false, yoloPlus: false },
      'YOLO → off: permission prompts are active.',
    );
  else return refused('Use /yolo, /yolo on, /yolo plus or /yolo off.');
  return HANDLED;
}

function runNextSteps(argument: string, context: DesktopCommandContext): DesktopCommandOutcome {
  const [first, second, ...rest] = argument.toLowerCase().split(/\s+/).filter(Boolean);
  if (!first || first === 'status') {
    const prefs = prefsOf(context);
    const mode = prefs['nextStepsMode'] === 'optional' ? 'optional' : 'required';
    const limit = sessionAutonomy(prefs).limit;
    context.notify(`Next steps: ${mode} · automatic continuation limit: ${limitText(limit)}.`);
    return HANDLED;
  }
  const usage = 'Use /nextsteps optional, /nextsteps required [limit] or /nextsteps limit <n>.';
  let mode: 'optional' | 'required' | undefined;
  let limitWord: string | undefined;
  if ((first === 'optional' || first === 'required') && rest.length === 0) {
    mode = first;
    limitWord = second;
  } else if ((first === 'limit' || first === 'max') && second && rest.length === 0) {
    limitWord = second;
  } else return refused(usage);
  let limit: number | undefined;
  if (limitWord !== undefined) {
    limit = NEXT_STEPS_UNLIMITED.has(limitWord)
      ? 0
      : /^\d+$/.test(limitWord)
        ? Number.parseInt(limitWord, 10)
        : undefined;
    if (limit === undefined)
      return refused(`Invalid limit “${limitWord}”. Use a whole number or unlimited.`);
  }
  const patch: Record<string, unknown> = {};
  const done: string[] = [];
  if (mode) {
    patch['nextStepsMode'] = mode;
    done.push(`Next steps → ${mode}.`);
  }
  if (limit !== undefined) {
    patch['autoProceedMaxIterations'] = limit;
    done.push(`Automatic continuation limit → ${limitText(limit)}.`);
  }
  savePrefs(context, patch, done.join(' '));
  return HANDLED;
}

/** The prompt a review command sends; the agent reads the changes with its own tools. */
function reviewPrompt(focus: string): string {
  const focusLine = focus
    ? `Focus especially on: ${focus}.`
    : 'Cover correctness bugs, security issues, performance, and obvious simplifications.';
  return (
    `Review the pending git changes (run \`git diff\` and \`git status\` to see them). ${focusLine} ` +
    'For each finding give the file, a short description, severity, and a concrete fix. ' +
    'If there are no changes, review the most recently edited files instead.'
  );
}

function runHunt(
  mode: BugHuntMode,
  name: string,
  argument: string,
  context: DesktopCommandContext,
): DesktopCommandOutcome {
  const label = huntLabel(mode);
  const usage = `${name} [--rounds 1..10] [scope]`;
  const parsed = parseHuntSlashArgs(argument);
  switch (parsed.kind) {
    case 'help':
      context.notify(
        `${label}: ${BUG_HUNT_MODE_DESCRIPTIONS[mode]} Usage: ${usage}, or ${name} stop.`,
      );
      return HANDLED;
    case 'error':
      return refused(`Usage: ${usage}. A hunt runs 1 to 10 rounds.`);
    case 'stop':
      context.notify(context.stopHunt() ?? 'No Proof-Driven Hunt is running in this conversation.');
      return HANDLED;
    case 'start':
      if (context.state.running)
        return refused(
          `Wait for the current turn to finish (or /stop it) before starting ${label}.`,
        );
      return { kind: 'hunt', request: { mode, maxBugs: parsed.maxBugs, scope: parsed.scope } };
  }
}

/**
 * Runs a draft that starts with a command against the composer and its conversation; null
 * when the draft is ordinary text.
 */
export function runDesktopCommand(
  draft: string,
  context: DesktopCommandContext,
): DesktopCommandOutcome | null {
  const parsed = parseDesktopCommand(draft);
  if (!parsed) return null;
  const { command, argument } = parsed;
  if (!command)
    return refused(
      `${parsed.name} is not a desktop command. Your draft was not sent; type /help for the list, or prefix it with // to send it as literal text.`,
    );
  const { action } = command;
  if (argument && !command.usage)
    return refused(`${command.name} takes no arguments. Your draft was not sent.`);
  switch (action) {
    case 'queue':
    case 'btw':
    case 'steer':
      if (argument) return { kind: 'submit', text: argument, mode: action };
      if (action !== 'queue') context.setMode(action);
      else if (!context.openQueue()) context.notify('There are no pending queued prompts.');
      return HANDLED;
    case 'review':
      return { kind: 'submit', text: reviewPrompt(argument) };
    case 'fix':
      return {
        kind: 'submit',
        text: argument
          ? `Diagnose and fix this error. Find the root cause, then apply the fix and explain it:\n\n${argument}`
          : 'Investigate the most recent error or failing test, find the root cause, fix it, and verify the fix.',
      };
    case 'suggest':
      return {
        kind: 'submit',
        text: 'Suggest exact prompt messages I can submit back to you. Each must ask you to perform the work and must not assign a manual chore to me. Be specific and actionable.',
      };
    case 'autonomy':
      return runAutonomy(argument, context);
    case 'mode':
      return runMode(argument, context);
    case 'yolo':
      return runYolo(argument, context);
    case 'nextsteps':
      return runNextSteps(argument, context);
    case 'hunt':
      return command.hunt ? runHunt(command.hunt, command.name, argument, context) : HANDLED;
    case 'goal':
      return runGoal(argument, context);
    case 'brain':
      return runBrain(argument, context);
    case 'mcp':
      return runMcp(argument, context);
    case 'doctor':
      return runDoctor(argument, context);
    case 'browser':
      return runBrowser(argument, context);
    case 'working-dir':
      return runWorkingDir(argument, context);
    case 'save':
      return runSave(context);
    case 'todos':
      return runTodos(argument, context);
    case 'next':
      return runNext(argument, context);
    case 'export':
      return runExport(context);
    case 'help':
      context.openHelp();
      return HANDLED;
    case 'library':
    case 'journal':
      context.openPrompts(action);
      return HANDLED;
    case 'context':
      context.openContext('inspect');
      return HANDLED;
    case 'compact':
    case 'compact-aggressive':
    case 'repair':
    case 'clear':
      context.openContext(action);
      return HANDLED;
    case 'stop':
      context.stop();
      return HANDLED;
    case 'enhance':
      context.toggleEnhance();
      return HANDLED;
    case 'settings':
      context.openSettings();
      return HANDLED;
    case 'open':
      if (command.opens) context.navigate(command.opens);
      return HANDLED;
  }
}

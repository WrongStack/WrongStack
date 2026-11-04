import {
  type DesktopCommandContext,
  type DesktopCommandOutcome,
  HANDLED,
  reason,
  refused,
} from './desktop-command-context';

const USAGE =
  'Use /goal, /goal start <title>, /goal set <mission>, /goal pause|resume|stop|clear|refine|save, or /goal load <name> [--resume].';

/** The newest goal run in one of `statuses`, as the engine last reported it. */
function goalIn(context: DesktopCommandContext, statuses: readonly string[]): string | undefined {
  return Object.entries(context.state.goalStates)
    .reverse()
    .find(([, goal]) => statuses.includes(String(goal['status'] ?? '')))?.[0];
}

/**
 * Sends a goal request and opens the goals page, which reports the outcome as the engine
 * broadcasts it: goal runs and the project mission answer no single request.
 */
function sendGoal(
  context: DesktopCommandContext,
  type: string,
  payload: Record<string, unknown>,
  done: string,
): DesktopCommandOutcome {
  void context.send(type, payload).then(
    () => context.notify(done),
    (error) => context.fail(reason(error)),
  );
  context.navigate({ page: 'goals' });
  return HANDLED;
}

/**
 * `/goal` as the WebUI routes it: the project mission (set, pause, resume, clear, refine) and
 * goal runs (start, pause, resume, stop, save, load). Pause, resume and stop act on the running
 * goal when there is one, and on the mission otherwise.
 */
export function runGoal(argument: string, context: DesktopCommandContext): DesktopCommandOutcome {
  const [sub = '', ...rest] = argument.split(/\s+/).filter(Boolean);
  const subcommand = sub.toLowerCase();
  const words = rest.join(' ').trim();
  switch (subcommand) {
    case '':
    case 'list':
    case 'status':
    case 'journal':
      context.navigate({ page: 'goals' });
      return HANDLED;
    case 'start':
      if (!words) return refused('Use /goal start <title>.');
      return sendGoal(
        context,
        'goal.start',
        { goalId: crypto.randomUUID(), title: words, autonomous: true },
        `Goal “${words}” submitted; the engine is planning it.`,
      );
    case 'set':
    case 'new':
      if (!words) return refused('Use /goal set <mission>.');
      return sendGoal(context, 'goal-state.set', { goal: words }, 'Project mission set.');
    case 'clear':
      return sendGoal(context, 'goal-state.clear', {}, 'Project mission cleared.');
    case 'refine':
      return sendGoal(context, 'goal-state.refine', {}, 'Refining the project mission.');
    case 'pause': {
      const goalId = goalIn(context, ['running']);
      return goalId
        ? sendGoal(context, 'goal.pause', { goalId }, 'Pausing the running goal.')
        : sendGoal(context, 'goal-state.pause', {}, 'Project mission paused.');
    }
    case 'resume': {
      const goalId = goalIn(context, ['paused', 'stopped', 'failed']);
      return goalId
        ? sendGoal(context, 'goal.resume', { goalId }, 'Resuming the goal.')
        : sendGoal(context, 'goal-state.resume', {}, 'Project mission resumed.');
    }
    case 'stop': {
      const goalId = goalIn(context, ['running', 'paused']);
      if (!goalId) return refused('No goal is running in this project.');
      return sendGoal(context, 'goal.stop', { goalId }, 'Stopping the goal.');
    }
    case 'save': {
      const goalId = goalIn(context, ['running', 'paused', 'stopped', 'failed', 'completed']);
      return sendGoal(context, 'goal.save', goalId ? { goalId } : {}, 'Saving the goal.');
    }
    case 'load': {
      const resume = rest.includes('--resume');
      const query = rest.filter((part) => part !== '--resume').join(' ');
      if (!query) return refused('Use /goal load <name> [--resume].');
      return sendGoal(context, 'goal.load', { query, resume }, `Loading goal “${query}”.`);
    }
    default:
      if (/^[a-z-]+$/.test(subcommand) && rest.length === 0) return refused(USAGE);
      return sendGoal(context, 'goal-state.set', { goal: argument }, 'Project mission set.');
  }
}

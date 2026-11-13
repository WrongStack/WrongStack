import type { SubagentRunner, TaskSpec } from '@wrongstack/contracts/types';
import { buildArchitectureDecisionBlock } from '@wrongstack/core/storage';

interface Snapshot {
  text: string;
  fingerprint: string;
}
const taskSnapshots = new WeakMap<TaskSpec, Snapshot>();

function snapshot(projectRoot: string): Snapshot {
  const meta: Record<string, unknown> = {};
  return {
    text: buildArchitectureDecisionBlock(projectRoot, meta)?.text ?? '',
    fingerprint: JSON.stringify(meta.architectureDecisionSnapshot ?? []),
  };
}

/** ACP/HTTP workers have their own request loops; deliver the same reviewed context in their task. */
export function withArchitectureDecisions(
  runner: SubagentRunner,
  projectRoot: string,
): SubagentRunner {
  return async (task, ctx) => {
    ctx.signal.throwIfAborted();
    const current = snapshot(projectRoot);
    const decorated = { ...task, description: `${current.text}\n\n${task.description}` };
    taskSnapshots.set(decorated, current);
    return runner(decorated, ctx);
  };
}

/** The host never starts a new turn to refresh decisions; unsupported updates wait for the next task. */
export function startArchitectureDecisionRefresh(options: {
  projectRoot: string;
  task: TaskSpec;
  signal: AbortSignal;
  steer: (
    text: string,
  ) => Promise<'injected' | 'promptRequired' | 'startedNewTurn' | 'unsupported'>;
  intervalMs?: number;
}): () => void {
  let applied = taskSnapshots.get(options.task)?.fingerprint ?? '';
  let stopped = false;
  let pending = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    options.signal.removeEventListener('abort', stop);
  };
  const check = async () => {
    if (stopped || pending || options.signal.aborted) return;
    pending = true;
    try {
      const current = snapshot(options.projectRoot);
      if (stopped || current.fingerprint === applied) return;
      const outcome = await options.steer(current.text);
      if (!stopped && outcome === 'injected') applied = current.fingerprint;
      // A transport without active-turn injection must never be asked to start repeated turns.
      if (outcome === 'unsupported' || outcome === 'startedNewTurn') stop();
    } catch {
      // Do not mark an unread or undelivered revision as applied. Retry at the next check.
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => void check(), options.intervalMs ?? 5000);
  timer.unref?.();
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  return stop;
}

import { projectNextStepsToolInput } from '@wrongstack/tools/next-steps';
import { projectToolMessage } from '@wrongstack/webui-protocol';
import type { ToolCallInfo, ServerMessage } from '../types.js';

/** Structured <nextsteps> tool input produced by `projectNextStepsToolInput`. */
type ToolInput = ReturnType<typeof projectNextStepsToolInput>;

export function handleToolStarted(
  message: ServerMessage,
  nextStepsByToolId: Map<string, ToolInput>,
  setRunning: React.Dispatch<React.SetStateAction<boolean>>,
  setActivity: React.Dispatch<React.SetStateAction<string>>,
  setToolCalls: React.Dispatch<React.SetStateAction<ToolCallInfo[]>>,
): void {
  const projection = projectToolMessage(message);
  if (projection?.kind !== 'started') return;
  const { name, id } = projection;
  if (name === 'nextsteps' && id) {
    nextStepsByToolId.set(id, projectNextStepsToolInput(projection.input));
  }
  setRunning(true);
  setActivity(`Running ${name}`);
  setToolCalls((current) => [
    ...current,
    { id, name, input: projection.input, status: 'running', ts: new Date().toISOString() },
  ]);
}

export function handleToolProgress(
  message: ServerMessage,
  setActivity: React.Dispatch<React.SetStateAction<string>>,
): void {
  const projection = projectToolMessage(message);
  if (projection?.kind === 'progress' && projection.text) {
    setActivity(projection.text.split('\n')[0] ?? 'Working');
  }
}

export function handleToolExecuted(
  message: ServerMessage,
  nextStepsByToolId: Map<string, ToolInput>,
  onNextStepsExtracted: (steps: ToolInput) => void,
  setActivity: React.Dispatch<React.SetStateAction<string>>,
  setToolCalls: React.Dispatch<React.SetStateAction<ToolCallInfo[]>>,
): void {
  const projection = projectToolMessage(message);
  if (projection?.kind !== 'executed') return;
  const execId = projection.id;
  const execName = projection.name;
  if (execName === 'nextsteps' && execId) {
    const steps = nextStepsByToolId.get(execId) ?? [];
    nextStepsByToolId.delete(execId);
    if (projection.ok && steps.length > 0) onNextStepsExtracted(steps);
  }
  setActivity('Thinking');
  if (execId || execName) {
    setToolCalls((current) => {
      let matchIndex = -1;
      for (let index = current.length - 1; index >= 0; index--) {
        const tc = current[index];
        if (tc?.status !== 'running') continue;
        if (execId ? tc.id === execId : tc.name === execName) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex < 0) return current;
      const target = current[matchIndex];
      if (!target) return current;
      const next = current.slice();
      next[matchIndex] = {
        ...target,
        status: projection.ok ? 'done' : 'error',
        output: projection.output,
        durationMs: projection.durationMs,
        ok: projection.ok,
        ...(projection.sage ? { sage: projection.sage } : {}),
      };
      return next;
    });
  }
}

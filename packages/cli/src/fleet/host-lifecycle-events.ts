import type { EventBus } from '@wrongstack/contracts/kernel';
import type { TaskResult } from '@wrongstack/contracts/types';

export function emitHostLifecycleCompleted(
  events: EventBus,
  sessionId: string,
  taskId: string,
  result: TaskResult,
): void {
  events.emit('subagent.task_completed', {
    sessionId,
    subagentId: result.subagentId,
    taskId,
    status: result.status,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    durationMs: result.durationMs,
    error: result.error,
    finalText: typeof result.result === 'string' ? result.result : result.partial?.text,
  });
}

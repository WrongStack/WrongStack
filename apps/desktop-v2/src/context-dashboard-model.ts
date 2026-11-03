import type {
  ContextDebugPayload,
  ContextSession,
} from '@wrongstack/project-surfaces/context/context-host';
import { sessionStartedAt } from './desktop-story-feed';
import type { EngineState } from './engine-state';

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * The conversation's context mode. A switch reply is the newest word on it, then the mode list
 * the engine last sent, then the mode the conversation started with.
 */
function activeContextMode(results: EngineState['results']): string {
  const listed = results['context.modes.list'];
  const rows = Array.isArray(listed?.['modes']) ? (listed['modes'] as unknown[]) : [];
  const flagged = rows.find(
    (row): row is { id: string } =>
      typeof row === 'object' &&
      row !== null &&
      (row as { isActive?: unknown }).isActive === true &&
      typeof (row as { id?: unknown }).id === 'string',
  );
  return (
    text(results['context.mode.changed']?.['id']) ??
    text(listed?.['activeId']) ??
    flagged?.id ??
    text(results['session.start']?.['contextMode']) ??
    '—'
  );
}

/** The running turn's iteration; a worker's own iterations are not the conversation's. */
function leaderIteration(state: EngineState): ContextSession['iteration'] {
  const started = state.results['iteration.started'];
  if (!state.running || !started) return null;
  const agentId = started['agentId'];
  if (typeof agentId === 'string' && agentId && agentId !== 'leader') return null;
  const index = count(started['index']);
  return index ? { index, max: count(started['maxIterations']) } : null;
}

/** What the context dashboard shows about one desktop conversation. */
export function contextSession(state: EngineState, projectRoot: string): ContextSession {
  const start = state.results['session.start'];
  const root = projectRoot.replace(/[\\/]+$/, '');
  return {
    lastInputTokens: state.context.tokens,
    maxContext: state.context.max,
    model: state.model,
    provider: state.provider,
    mode: text(start?.['mode']) ?? 'default',
    contextMode: activeContextMode(state.results),
    startTime: sessionStartedAt(state) || null,
    iteration: leaderIteration(state),
    projectName: root.split(/[\\/]/).at(-1) ?? '',
    cwd: projectRoot,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The engine's `context.debug` reply as the dashboard reads it; anything else is an error. */
export function contextBreakdown(reply: Record<string, unknown>): ContextDebugPayload {
  const tools = reply['tools'];
  const messages = reply['messages'];
  if (
    typeof reply['total'] !== 'number' ||
    !isRecord(tools) ||
    !Array.isArray(tools['breakdown']) ||
    !isRecord(messages)
  )
    throw new Error(
      text(reply['message']) ?? 'The engine did not report how the context is made up.',
    );
  return reply as unknown as ContextDebugPayload;
}

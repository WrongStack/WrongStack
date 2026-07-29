import { createHash, type Hash } from 'node:crypto';
import type { EventBus } from '../kernel/events.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput } from './types.js';

export interface ChronicleStreamAdapterOptions {
  events: EventBus; journal: ChronicleEventSink; context: ChronicleContext | (() => ChronicleContext);
  onPersistError?: ((error: unknown, event: ChronicleEventInput) => void) | undefined;
}
interface StreamState {
  sessionId?: string; agentId?: string; attemptId: string; logicalRequestId: string; providerId: string; model: string;
  startedAtMs: number; firstChunkAtMs?: number; lastChunkAtMs?: number;
  textChunks: number; textBytes: number; thinkingChunks: number; thinkingBytes: number;
  textHash: Hash; thinkingHash: Hash;
}

/** Max age in ms before an incomplete stream state is force-flushed as a failure. */
const MAX_STATE_AGE_MS = 300_000;

/** Aggregates high-frequency streaming deltas without dropping their volume/timing/content identity. */
export function wireProviderStreamsToChronicle(options: ChronicleStreamAdapterOptions): () => void {
  const states = new Map<string, StreamState>();
  const key = (sessionId: string | undefined, agentId: string | undefined) => `${sessionId ?? '__default__'}\0${agentId ?? '__leader__'}`;
  const update = (sessionId: string | undefined, agentId: string | undefined, text: string, thinking: boolean): void => {
    const now = Date.now();
    // Proactive sweep: flush every state that has been alive too long without
    // completion/failure. Runs on every delta to catch completely silent stale
    // states — even entries that never receive another delta for their own key
    // will eventually be swept when a delta arrives for ANY active attempt.
    if (states.size > 0) {
      for (const [, s] of states) {
        if (now - s.startedAtMs > MAX_STATE_AGE_MS) {
          flush(s.sessionId, s.agentId, 'failure');
        }
      }
    }
    const k = key(sessionId, agentId);
    const state = states.get(k);
    if (!state) return;
    const bytes = Buffer.byteLength(text);
    state.firstChunkAtMs ??= now; state.lastChunkAtMs = now;
    if (thinking) { state.thinkingChunks++; state.thinkingBytes += bytes; state.thinkingHash.update(text); }
    else { state.textChunks++; state.textBytes += bytes; state.textHash.update(text); }
  };
  const flush = (sessionId: string | undefined, agentId: string | undefined, outcome: 'success' | 'failure'): void => {
    const state = states.get(key(sessionId, agentId)); if (!state) return; states.delete(key(sessionId, agentId));
    const context = typeof options.context === 'function' ? options.context() : options.context;
    const endedAtMs = Date.now();
    const input: ChronicleEventInput = { eventType: 'provider.stream.summarized', outcome,
      scope: { ...context.scope, ...(state.sessionId ? { sessionId: state.sessionId } : {}), ...(state.agentId ? { agentId: state.agentId } : {}) },
      correlation: { ...context.correlation, attemptId: state.attemptId, logicalRequestId: state.logicalRequestId },
      runtime: { providerId: state.providerId, modelId: state.model },
      durationNs: String(Math.max(0, endedAtMs - state.startedAtMs) * 1_000_000),
      attributes: { textChunks: state.textChunks, textBytes: state.textBytes,
        thinkingChunks: state.thinkingChunks, thinkingBytes: state.thinkingBytes,
        textHash: state.textHash.digest('hex'), thinkingHash: state.thinkingHash.digest('hex'),
        firstChunkLatencyMs: state.firstChunkAtMs === undefined ? undefined : state.firstChunkAtMs - state.startedAtMs,
        streamActiveMs: state.firstChunkAtMs === undefined || state.lastChunkAtMs === undefined ? 0 : state.lastChunkAtMs - state.firstChunkAtMs },
    };
    void options.journal.append(input).catch((error) => options.onPersistError?.(error, input));
  };
  const offs = [
    options.events.on('provider.attempt.started', (event) => states.set(key(event.sessionId,event.agentId), {
      sessionId: event.sessionId, ...(event.agentId ? { agentId:event.agentId } : {}), attemptId: event.attemptId, logicalRequestId: event.logicalRequestId,
      providerId: event.providerId, model: event.model, startedAtMs: Date.parse(event.startedAt),
      textChunks: 0, textBytes: 0, thinkingChunks: 0, thinkingBytes: 0,
      textHash: createHash('sha256'), thinkingHash: createHash('sha256'),
    })),
    options.events.on('provider.text_delta', (event) => update(event.sessionId, event.ctx.agentId, event.text, false)),
    options.events.on('provider.thinking_delta', (event) => update(event.sessionId, event.ctx.agentId, event.text, true)),
    options.events.on('provider.attempt.completed', (event) => flush(event.sessionId, event.agentId, 'success')),
    options.events.on('provider.attempt.failed', (event) => flush(event.sessionId, event.agentId, 'failure')),
  ];
  return () => { for (const state of [...states.values()]) flush(state.sessionId, state.agentId, 'failure'); offs.forEach((off) => { off(); }); };
}

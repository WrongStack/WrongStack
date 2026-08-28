import type { EventName, Listener } from '@wrongstack/core/kernel';
import type { WebSocket } from 'ws';
import type { SetupEventProjection } from './setup-event-projection.js';
import type { ConnectedClient, WSServerMessage } from './types.js';

type SetupEventOn = <E extends EventName>(event: E, listener: Listener<E>) => void;
type SetupEventBroadcast = (
  clients: Map<WebSocket, ConnectedClient>,
  msg: WSServerMessage,
) => void;
type SessionPayload = <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };

interface SetupEventsProviderHandlersDeps {
  on: SetupEventOn;
  broadcast: SetupEventBroadcast;
  clients: Map<WebSocket, ConnectedClient>;
  projection?: SetupEventProjection | undefined;
  sessionPayload: SessionPayload;
}

export function registerSetupEventsProviderHandlers({
  on,
  broadcast,
  clients,
  projection,
  sessionPayload,
}: SetupEventsProviderHandlersDeps): void {
  on('provider.response', (e) => {
    projection?.flushAllStreamBuffers?.();
    broadcast(clients, {
      type: 'provider.response',
      payload: sessionPayload({
        sessionId: e.sessionId,
        content: e.content,
        usage: e.usage,
        provider: e.ctx.provider.id,
        stopReason: e.stopReason,
        messageId: 'current',
      }),
    });
  });

  on('ctx.pct', (e) => {
    broadcast(clients, {
      type: 'ctx.pct',
      payload: sessionPayload({
        sessionId: e.sessionId,
        load: e.load,
        tokens: e.tokens,
        maxContext: e.maxContext,
      }),
    });
    broadcast(clients, {
      type: 'subagent.event',
      payload: sessionPayload({
        sessionId: e.sessionId,
        kind: 'ctx_pct',
        subagentId: 'leader',
        load: e.load,
        tokens: e.tokens,
        maxContext: e.maxContext,
      }),
    });
  });

  on('ctx.max_context', (e) => {
    broadcast(clients, {
      type: 'ctx.max_context',
      payload: sessionPayload({
        sessionId: e.sessionId,
        providerId: e.providerId,
        modelId: e.modelId,
        maxContext: e.maxContext,
        ...(e.previousMaxContext !== undefined
          ? { previousMaxContext: e.previousMaxContext }
          : {}),
        ...(e.source !== undefined ? { source: e.source } : {}),
        ...(e.decreased !== undefined ? { decreased: e.decreased } : {}),
      }),
    });
  });

  on('token.threshold', (e) => {
    broadcast(clients, {
      type: 'token.threshold',
      payload: sessionPayload({ sessionId: e.sessionId, used: e.used, limit: e.limit }),
    });
  });

  on('token.cost_estimate_unavailable', (e) => {
    broadcast(clients, {
      type: 'token.cost_estimate_unavailable',
      payload: sessionPayload({ sessionId: e.sessionId, model: e.model }),
    });
  });

  on('context.repaired', (e) => {
    broadcast(clients, {
      type: 'context.repaired',
      payload: sessionPayload({
        sessionId: e.sessionId,
        removedToolUses: e.removedToolUses,
        removedToolResults: e.removedToolResults,
        removedMessages: e.removedMessages,
      }),
    });
  });
}

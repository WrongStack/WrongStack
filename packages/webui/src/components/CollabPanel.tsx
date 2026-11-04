import {
  type CollabClient,
  type CollabPendingTool,
  forgetCollabSession,
  CollabPanel as SharedCollabPanel,
} from '@wrongstack/project-surfaces/collab/CollabPanel';
import { useMemo } from 'react';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore } from '@/stores';
import { onLaneDisposed } from '@/stores/chat-lanes';
import type { WSClientMessage } from '@/types';

onLaneDisposed(forgetCollabSession);

/**
 * The shared collaboration panel on this tab's WebSocket: in-flight tool calls (a `tool`
 * message with no result yet) are the targets a controller can inject a result for.
 */
export function CollabPanel({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string | undefined;
}) {
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const ws = getWSClient(wsUrl);
  const client = useMemo<CollabClient>(
    () => ({
      on: (type, handler) =>
        ws.on(type, (msg) => handler({ type: msg.type, payload: msg.payload })),
      send: (type, payload) => ws.send({ type, payload } as WSClientMessage),
    }),
    [ws],
  );
  const messages = useChatStore((s) => s.messages);
  const pendingTools = useMemo<CollabPendingTool[]>(
    () =>
      messages
        .filter((m) => m.role === 'tool' && m.toolResult === undefined && !!m.toolUseId)
        .map((m) => ({
          toolUseId: m.toolUseId as string,
          toolName: m.toolName,
          toolInput: m.toolInput,
        })),
    [messages],
  );
  return (
    <SharedCollabPanel
      sessionId={sessionId}
      client={client}
      pendingTools={pendingTools}
      className={className}
    />
  );
}

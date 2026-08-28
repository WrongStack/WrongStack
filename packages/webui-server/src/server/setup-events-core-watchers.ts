import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { EventBus, EventName, Listener } from '@wrongstack/core/kernel';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { subscribeKanbanDaemonEvents } from './kanban-daemon-subscriber.js';
import type { ConnectedClient, WSServerMessage } from './types.js';

interface SetupEventsCoreWatcherDeps {
  events: EventBus;
  broadcast: (
    clients: Map<WebSocket, ConnectedClient>,
    msg: WSServerMessage,
    /** Deliver to the tab that owns this session, overriding the id on the
     *  payload. Needed when the payload names a SUBAGENT's session, which no
     *  tab subscribes to. */
    targetSessionId?: string,
  ) => void;
  clients: Map<WebSocket, ConnectedClient>;
  context: Context;
  wpaths?: WstackPaths | undefined;
}

export function registerSetupEventsCoreWatchers(
  deps: SetupEventsCoreWatcherDeps,
): Array<() => void> {
  const { broadcast, clients, context } = deps;
  const disposers: Array<() => void> = [];
  const conversationState = (context as { state?: Context['state'] }).state;
  if (typeof conversationState?.onChange === 'function') {
    disposers.push(
      conversationState.onChange((change) => {
        if (change.kind !== 'todos_replaced') return;
        broadcast(clients, {
          type: 'todos.updated',
          payload: {
            sessionId: context.session?.id ?? '',
            todos: [...change.todos],
            revision: conversationState.revision,
          },
        });
      }),
    );
  }

  const projectRoot = context.projectRoot;
  if (projectRoot) {
    disposers.push(
      subscribeKanbanDaemonEvents(projectRoot, (message) => broadcast(clients, message)),
    );
  }
  return disposers;
}

export function registerSetupEventsClientStatusWriter(
  deps: SetupEventsCoreWatcherDeps,
): () => void {
  const { broadcast, clients, events, wpaths } = deps;
  const on = <E extends EventName>(event: E, listener: Listener<E>): (() => void) =>
    events.on(event, listener);

  return on('client.status', async (e) => {
    broadcast(clients, { type: 'client.status_update', payload: e });

    if (wpaths?.projectStatus && e.projectHash !== 'unknown') {
      try {
        const statusFile = wpaths.projectStatus(e.projectHash);
        const dir = path.dirname(statusFile);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(statusFile, JSON.stringify(e, null, 2), 'utf-8');
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'setup_events.status_write_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  });
}

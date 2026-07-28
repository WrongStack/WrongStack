import {
  getSharedProjectMailbox,
  mailboxSessionTag,
  type AgentMonitorService,
  type Director,
} from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Config } from '@wrongstack/core/types';

import { createFleetStatusBroadcaster } from './status-broadcast.js';

type FleetStatusBroadcastConfig = NonNullable<Config['fleet']>['statusBroadcasts'];

export function startDirectorAgentMonitor(input: {
  director: Director;
  agentMonitor?: AgentMonitorService | undefined;
}): void {
  const { director, agentMonitor } = input;
  if (!agentMonitor) return;
  agentMonitor.setFleetBus(director.fleet);
  agentMonitor.start();
}

export function createHostStatusBroadcaster(input: {
  events: EventBus;
  sessionId: string;
  mailboxProjectDir(): string;
  subagentName(subagentId: string): string | undefined;
  config?: FleetStatusBroadcastConfig | undefined;
}): { start(): void; stop(): void } {
  const { events, sessionId, mailboxProjectDir, subagentName, config } = input;
  return createFleetStatusBroadcaster({
    events,
    mailboxFactory: () => getSharedProjectMailbox(mailboxProjectDir(), events),
    sessionTag: () => mailboxSessionTag(sessionId),
    subagentName,
    config,
  });
}

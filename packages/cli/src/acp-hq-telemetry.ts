/**
 * ACP sessions on the HQ fleet map.
 *
 * An editor driving WrongStack over ACP (Zed, JetBrains, …) runs real turns:
 * real provider calls, real tools, real cost. HQ never saw any of it. The only
 * trace an ACP process left was the mailbox-only publisher every agent process
 * opens, which shows up as a client with no session and no agents — so an
 * operator watching the fleet had no way to tell an ACP server was working at
 * all, let alone what it was doing.
 *
 * The wiring is unusually cheap here because ACP already gives every session
 * its own `EventBus` (`buildAcpServerAgentFactory`): a tracker attached to that
 * bus needs no session filtering, unlike the WebUI's shared-bus host.
 *
 * What this does NOT give you is a chat transcript. ACP sessions run on a
 * no-op session writer — they do not persist a JSONL journal — so HQ's Console
 * has nothing to replay for them. The agent card is live (status, current
 * tool, iterations, tokens, cost, streaming tail); the conversation is not.
 * Giving ACP a real journal is a separate change: it would also put ACP
 * sessions into `/resume`, recovery and history.
 *
 * @module acp-hq-telemetry
 */

import type { Agent } from '@wrongstack/core/agent';
import { AgentStatusTracker } from '@wrongstack/core/coordination';
import { startSessionTelemetryBridge } from '@wrongstack/core/hq';
import type { Config } from '@wrongstack/core/types';
import { startCliHqConnection } from './hq-publisher.js';

/** The per-session Agent factory shape `makeACPServerAgentTurn` consumes. */
type AcpAgentFactory = (sessionId: string, cwd: string, api?: never) => Promise<Agent>;

export interface AcpHqTelemetryOptions {
  projectRoot: string;
  projectName?: string | undefined;
  appConfig?: Config | undefined;
}

export interface AcpHqTelemetry {
  /** Wrap the agent factory so each new ACP session reports to HQ. */
  wrapAgentFactory<T extends AcpAgentFactory>(agentFor: T): T;
  /** Wrap `dispose` so a closed ACP session stops reporting. */
  wrapDispose(dispose: (sessionId: string) => void): (sessionId: string) => void;
  /** Session ids currently reporting. Exposed for tests and diagnostics. */
  active(): string[];
  stop(): void;
}

/**
 * Cross-process presence is owned by the session registry, which ACP does not
 * participate in. These trackers exist only to feed `session.agents_updated`
 * for their session's HQ bridge.
 */
const NO_REGISTRY = { updateAgents: async (): Promise<void> => undefined };

export function startAcpHqTelemetry(options: AcpHqTelemetryOptions): AcpHqTelemetry {
  const connection = startCliHqConnection({
    clientKind: 'acp',
    projectRoot: options.projectRoot,
    ...(options.projectName !== undefined ? { projectName: options.projectName } : {}),
    ...(options.appConfig !== undefined ? { appConfig: options.appConfig } : {}),
    capabilities: ['telemetry.publish', 'mailbox.summary', 'fleet.summary', 'session.summary'],
  });

  interface Entry {
    tracker: AgentStatusTracker;
    stopBridge: () => void;
  }
  const entries = new Map<string, Entry>();
  let stopped = false;

  const attach = (sessionId: string, agent: Agent, cwd: string): void => {
    if (stopped || entries.has(sessionId)) return;
    const publisher = connection.getPublisher();
    if (publisher === undefined) return;
    const events = agent.events;
    if (events === undefined) return;
    const tracker = new AgentStatusTracker({ events, registry: NO_REGISTRY, sessionId });
    tracker.start();
    let stopBridge: () => void;
    try {
      stopBridge = startSessionTelemetryBridge({
        publisher,
        events,
        sessionId,
        // An ACP session works in the directory the client opened, which is
        // not necessarily where the server booted.
        projectRoot: cwd,
        projectName: options.projectName ?? options.projectRoot,
        initialAgents: tracker.getAgents(),
        startedAt: new Date().toISOString(),
      });
    } catch {
      // Telemetry is best-effort; a failed bridge must not leave its tracker
      // subscribed to the session's bus for the life of the process.
      tracker.stop();
      return;
    }
    entries.set(sessionId, { tracker, stopBridge });
  };

  const detach = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (entry === undefined) return;
    entries.delete(sessionId);
    try {
      // Publishes `session.ended`, so a closed editor session leaves the map
      // immediately instead of ageing out of it.
      entry.stopBridge();
    } catch {
      /* best-effort */
    }
    try {
      entry.tracker.stop();
    } catch {
      /* best-effort */
    }
  };

  return {
    wrapAgentFactory<T extends AcpAgentFactory>(agentFor: T): T {
      const wrapped = async (sessionId: string, cwd: string, api?: never): Promise<Agent> => {
        const agent = await agentFor(sessionId, cwd, api);
        try {
          attach(sessionId, agent, cwd);
        } catch {
          // HQ visibility must never be the reason an editor's session fails
          // to start.
        }
        return agent;
      };
      return wrapped as T;
    },
    wrapDispose(dispose: (sessionId: string) => void): (sessionId: string) => void {
      return (sessionId: string) => {
        try {
          detach(sessionId);
        } catch {
          /* best-effort */
        }
        dispose(sessionId);
      };
    },
    active: () => [...entries.keys()],
    stop: () => {
      stopped = true;
      for (const sessionId of [...entries.keys()]) detach(sessionId);
      connection.stop();
    },
  };
}

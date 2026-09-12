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
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  startApprovalTelemetryBridge,
  startSessionTelemetryBridge,
} from '@wrongstack/core/hq';
import type { Config } from '@wrongstack/core/types';
import { createHqCommandDispatcher } from './hq-command-controller.js';
import { startCliHqConnection } from './hq-publisher.js';

/**
 * The per-session Agent factory shape `makeACPServerAgentTurn` consumes.
 *
 * Typed on `...args` rather than a fixed parameter list on purpose: the
 * wrapper below must forward every argument the adapter passes, and the list
 * has grown (it now carries the client's `mcpServers`). A wrapper that names
 * its parameters silently drops the ones added after it was written.
 */
type AcpAgentFactory = (sessionId: string, cwd: string, ...rest: never[]) => Promise<Agent>;

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
  interface Entry {
    tracker: AgentStatusTracker;
    stopBridge: () => void;
    approvals?: ApprovalRegistry | undefined;
    stopApprovalBridge?: (() => void) | undefined;
  }
  const entries = new Map<string, Entry>();
  let stopped = false;

  /**
   * Answer a permission prompt on the ACP session that raised it.
   *
   * Unlike every other host, ACP gives each session its OWN EventBus, so there
   * is a registry per session rather than one per process. That makes the
   * session id load-bearing: without it there is nothing to pick a registry
   * with, and answering "whichever" would approve a tool call in a different
   * editor tab than the operator was looking at.
   */
  const resolveApproval = (
    toolUseId: string,
    decision: 'yes' | 'no' | 'always' | 'deny',
    sessionId?: string,
  ): boolean => {
    if (sessionId !== undefined) {
      return entries.get(sessionId)?.approvals?.resolve(toolUseId, decision, sessionId) ?? false;
    }
    // No session named: the prompt id is unique across them, so it still
    // identifies exactly one prompt. Only reached by an older dashboard.
    for (const entry of entries.values()) {
      if (entry.approvals?.resolve(toolUseId, decision) === true) return true;
    }
    return false;
  };

  const connection = startCliHqConnection({
    clientKind: 'acp',
    projectRoot: options.projectRoot,
    ...(options.projectName !== undefined ? { projectName: options.projectName } : {}),
    ...(options.appConfig !== undefined ? { appConfig: options.appConfig } : {}),
    capabilities: [
      'telemetry.publish',
      'mailbox.summary',
      'fleet.summary',
      'session.summary',
      // Approvals are the ONLY control this host accepts. `control.receive` is
      // the server's gate for any command at all, so it has to be declared;
      // everything except `approve` falls through the dispatcher and is
      // refused, because an ACP session has no mailbox to steer and no leader
      // to abort.
      'control.receive',
      'control.approve',
    ],
    onCommand: createHqCommandDispatcher({
      interruptLeader: () => false,
      sessionTag: () => 'acp',
      ownsSession: (sessionId) => entries.has(sessionId),
      allowRunCommand: () => false,
      resolveApproval,
    }),
  });

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
    const entry: Entry = { tracker, stopBridge };
    try {
      // Per session, because the bus is per session. Disposed in `detach`, so
      // a closed editor tab does not leave its prompts answerable.
      const approvals = createApprovalRegistry(events);
      entry.approvals = approvals;
      entry.stopApprovalBridge = startApprovalTelemetryBridge({
        registry: approvals,
        publisher,
        projectRoot: cwd,
        sessionId,
      });
    } catch {
      // Approval mirroring is optional; the session still reports normally.
    }
    entries.set(sessionId, entry);
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
      entry.stopApprovalBridge?.();
    } catch {
      /* best-effort */
    }
    try {
      // Disposed, not drained: the prompts belong to the editor session that
      // raised them, and answering them here because HQ lost sight of the
      // session would decide for the user.
      entry.approvals?.dispose();
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
      const wrapped = async (sessionId: string, cwd: string, ...rest: never[]): Promise<Agent> => {
        const agent = await agentFor(sessionId, cwd, ...rest);
        try {
          attach(sessionId, agent, cwd);
        } catch {
          // HQ visibility must never be the reason an editor's session fails
          // to start.
        }
        return agent;
      };
      // Carry over own properties the factory exposes alongside the call
      // signature (`disposeSession`), so wrapping does not amputate them.
      Object.assign(wrapped, agentFor);
      return wrapped as unknown as T;
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

/**
 * The host services an ACP leader gets from the CLI (see acp-leader-host.ts),
 * bound to the agent that runs each session: the leader in the REPL and TUI,
 * and on the WebUI each tab's own agent, so the workers a tab's agent starts
 * belong to that tab.
 */
import { randomUUID } from 'node:crypto';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, ConfirmAwaiter, Tool, ToolSettlement } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import {
  type AcpLeaderHost,
  type AcpLeaderSessionAgent,
  acpLeaderSessionAgent,
} from './acp-leader-host.js';
import { cardOutputForText } from './acp-leader-stream.js';

export interface AcpLeaderHostOptions {
  /** The leader: the agent of any session the host does not run itself. */
  agent: Agent;
  events: EventBus;
  projectRoot: string;
  stateDir?: string | undefined;
  getConfig(): Config;
  getTool(name: string): Tool | undefined;
  listTools?(): Tool[];
  confirmAwaiter?: ConfirmAwaiter | undefined;
}

export function createAcpLeaderHost(opts: AcpLeaderHostOptions): AcpLeaderHost {
  const agentFor = (sessionId: string | undefined): AcpLeaderSessionAgent =>
    (sessionId ? acpLeaderSessionAgent(sessionId) : undefined) ?? opts.agent;
  return {
    events: opts.events,
    projectRoot: opts.projectRoot,
    stateDir: opts.stateDir,
    getConfig: opts.getConfig,
    permission: (sessionId) => agentFor(sessionId).permission,
    context: (sessionId) => agentFor(sessionId).ctx,
    getTool: opts.getTool,
    ...(opts.listTools ? { listTools: opts.listTools } : {}),
    runTool: async (name, input, run = {}) => {
      const agent = agentFor(run.sessionId);
      const use = { type: 'tool_use' as const, id: `acp_fleet_${randomUUID()}`, name, input };
      const startedAt = Date.now();
      // The executor announced the call (`tool.started`, same id); a surface
      // holds that card open until this settles it.
      const settle = (content: string, ok: boolean, settlement: ToolSettlement) => {
        if (!run.announce) return;
        opts.events.emit('tool.executed', {
          sessionId: agent.ctx.activeRunSessionId ?? agent.ctx.session?.id,
          agentId: 'leader',
          id: use.id,
          name,
          durationMs: Date.now() - startedAt,
          ok,
          settlement,
          input: use.input,
          outsideConversation: true,
          ...cardOutputForText(content),
        });
      };
      const batch = await agent.toolExecutor.executeBatch([use], agent.ctx, 'sequential');
      let result = batch.outputs[0]?.result;
      if (result?.type === 'tool_confirm_pending') {
        // The policy wants this call confirmed. The permission request the
        // agent sent for it was usually asked already; `approve` knows.
        const tool = opts.getTool(name);
        const approved = { ...use, input: result.input as Record<string, unknown> };
        if (!tool || !(await run.approve?.(tool, approved.input))) {
          const content = `${name} was not approved by the user.`;
          settle(content, false, 'declined');
          return { content, isError: true };
        }
        result = (
          await agent.toolExecutor.executeTool(
            tool,
            approved,
            agent.ctx,
            agent.perIterationOutputCapBytes,
          )
        ).block;
      }
      if (!result) {
        const content = `${name} returned no result.`;
        settle(content, false, 'failed');
        return { content, isError: true };
      }
      const content =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      settle(content, !result.is_error, result.is_error ? 'failed' : 'completed');
      return { content, isError: Boolean(result.is_error) };
    },
    confirmAwaiter: opts.confirmAwaiter,
  };
}

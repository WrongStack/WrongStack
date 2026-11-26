/**
 * The leader agent's calls that need the user's yes: its permission request,
 * asked on the surface the session has (the REPL's own prompt, a TUI/WebUI
 * tab's), and the fleet calls the user already approved there, which the run
 * that follows must not ask about again.
 */
import type { AcpChildSource } from '@wrongstack/acp';
import type { Tool } from '@wrongstack/contracts/types';
import { sanitizeTerminalPreview, subjectForToolInput } from '@wrongstack/core/utils';
import { confirmThroughEvents, rememberConfirmAnswer } from './acp-leader-confirm.js';
import { FLEET_TOOLS } from './acp-leader-fleet.js';
import { acpLeaderHost } from './acp-leader-host.js';

/** A fleet call's identity: its session, tool and input, keys in a stable order. */
function fleetGrantKey(sessionId: string, tool: string, input: unknown): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
          )
        : value;
  return JSON.stringify([sessionId, tool, stable(input)]);
}

/** The agent's call an approval is about: its tool call, and the subagent that made it. */
export interface LeaderCallRequest {
  toolCallId: string | undefined;
  signal: AbortSignal;
  child?: AcpChildSource | undefined;
}

export class LeaderApprovals {
  /**
   * Fleet calls the user already approved through the agent's permission
   * request, by session, tool and input: the call that follows runs on that
   * approval instead of asking again.
   */
  private readonly fleetGrants = new Map<string, number>();

  /**
   * Ask the user about one of the agent's calls on the prompt the surface
   * has: the REPL's own, or the TUI/WebUI approval prompt in the session's tab.
   */
  async confirm(
    sessionId: string,
    tool: Tool,
    input: Record<string, unknown>,
    request: LeaderCallRequest,
  ): Promise<boolean> {
    const approved = await this.ask(sessionId, tool, input, request);
    // A fleet tool runs in this process right after; that run must not ask again.
    if (approved && !request.child && FLEET_TOOLS.includes(tool.name)) {
      const key = fleetGrantKey(sessionId, tool.name, input);
      this.fleetGrants.set(key, (this.fleetGrants.get(key) ?? 0) + 1);
    }
    return approved;
  }

  /**
   * A fleet call the policy wants confirmed: the approval the user gave the
   * agent's permission request for it, once, or a question now (an agent
   * whose own settings let it call the tool without asking).
   */
  async approveFleetCall(
    sessionId: string,
    tool: Tool,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    const key = fleetGrantKey(sessionId, tool.name, input);
    const granted = this.fleetGrants.get(key) ?? 0;
    if (granted > 0) {
      if (granted === 1) this.fleetGrants.delete(key);
      else this.fleetGrants.set(key, granted - 1);
      return true;
    }
    return this.ask(sessionId, tool, input, {
      toolCallId: undefined,
      signal: new AbortController().signal,
    });
  }

  /** Forget the approvals of a session that ended. */
  dropSession(sessionId: string): void {
    for (const grantKey of this.fleetGrants.keys()) {
      try {
        const parsed = JSON.parse(grantKey) as unknown;
        if (Array.isArray(parsed) && parsed[0] === sessionId) {
          this.fleetGrants.delete(grantKey);
        }
      } catch {
        // ignore
      }
    }
  }

  private async ask(
    sessionId: string,
    tool: Tool,
    input: Record<string, unknown>,
    request: LeaderCallRequest,
  ): Promise<boolean> {
    const host = acpLeaderHost();
    const suggestedPattern =
      subjectForToolInput(tool.name, input, tool.subjectKey, tool.subjectFields) ?? tool.name;
    const callId = request.toolCallId ?? `acp-${Date.now()}`;
    const toolUseId = request.child
      ? JSON.stringify(['acp-child', request.child.id, callId])
      : callId;
    if (host?.confirmAwaiter) {
      const answer = await host.confirmAwaiter(tool, input, toolUseId, suggestedPattern);
      await rememberConfirmAnswer(
        {
          tool,
          input,
          suggestedPattern,
          permission: host.permission(sessionId),
          context: host.context(sessionId),
        },
        answer,
      );
      return answer !== 'no' && answer !== 'deny';
    }
    if (!host?.confirmThroughEvents) return false;
    return confirmThroughEvents({
      events: host.events,
      sessionId,
      tool,
      input,
      toolUseId,
      suggestedPattern,
      signal: request.signal,
      ...(request.child
        ? {
            boundaryReason: `ACP subagent ${sanitizeTerminalPreview(request.child.title ?? request.child.id, { maxLines: 1, maxChars: 300 }).text}`,
          }
        : {}),
      permission: host.permission(sessionId),
      context: host.context(sessionId),
    });
  }
}

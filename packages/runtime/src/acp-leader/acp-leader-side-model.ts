/**
 * Which requests reach the agent leading the session, and where a side request
 * goes instead: sent to the agent, it would arrive in the user's session as a
 * prompt.
 */
import type { Config, Request } from '@wrongstack/contracts/types';
import { ACP_LEADER_PROVIDER_ID } from './acp-leader-host.js';

/** `provider/model` → its parts; a bare id or the ACP provider itself is unusable here. */
function parseSideModel(ref: string | undefined): { provider: string; model: string } | undefined {
  const slash = ref?.indexOf('/') ?? -1;
  if (!ref || slash <= 0 || slash === ref.length - 1) return undefined;
  const provider = ref.slice(0, slash);
  if (provider === ACP_LEADER_PROVIDER_ID) return undefined;
  return { provider, model: ref.slice(slash + 1) };
}

/**
 * The side model the user set for an agent leader (`acp.leader.sideModel`),
 * without falling back to the fallback chain: a leader that can answer side
 * requests itself (WrongForge) must not hand them to `fallbackModels[0]`.
 */
export function explicitLeaderSideModel(
  config: Config,
): { provider: string; model: string } | undefined {
  return parseSideModel(config.acp?.leader?.sideModel);
}

export function leaderSideModel(config: Config): { provider: string; model: string } | undefined {
  return (
    explicitLeaderSideModel(config) ??
    parseSideModel(config.fallbackBridge) ??
    parseSideModel(config.fallbackModels?.[0])
  );
}

/** A leader turn: the request's thread is its own conversation (a subagent's is not). */
export function isLeaderTurn(req: Request): boolean {
  const { sessionId, threadId } = req.cache ?? {};
  return !sessionId || !threadId || sessionId === threadId;
}

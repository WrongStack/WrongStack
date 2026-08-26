/**
 * Which tab does a fleet agent belong to?
 *
 * Fail-CLOSED, deliberately: an agent must NAME a session to be listed under
 * it. Every roster in the app used to spell this as
 *
 *   !a.sessionId || !currentSessionId || a.sessionId === currentSessionId
 *
 * which lists an untagged agent in all four tabs at once — the roster half of
 * the cross-tab bleed. The server stamps every `subagent.event` through
 * `sessionPayload()`, so an untagged agent is a bug upstream, not a normal
 * case to be generous about; showing it four times hides that bug instead of
 * surfacing it.
 *
 * Before a session exists, only the equally session-less agents match, which
 * keeps the pre-session roster non-empty without ever crossing a tab.
 */
export function agentBelongsToSession(
  agentSessionId: string | undefined,
  sessionId: string | undefined,
): boolean {
  return sessionId ? agentSessionId === sessionId : !agentSessionId;
}

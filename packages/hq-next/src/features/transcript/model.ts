/**
 * Transcript entry rules that are independent of rendering.
 */
import type { HqTranscriptEntry } from '@wrongstack/hq';

/**
 * Whether a tool entry failed. The transcript pipeline marks a failure either
 * with `isError` or by merging the failed call into its argument entry with
 * role `error`; both must read as failed, or a broken call shows a green tick.
 */
export function isFailedTool(entry: Pick<HqTranscriptEntry, 'role' | 'isError'>): boolean {
  return entry.isError === true || entry.role === 'error';
}

/** Whether an entry renders as a tool row rather than a message. */
export function isToolEntry(entry: Pick<HqTranscriptEntry, 'role' | 'toolInput'>): boolean {
  return entry.role === 'tool' || (entry.role === 'error' && entry.toolInput !== undefined);
}

/**
 * Who said a turn. The leader is the conversation's own voice; any other
 * agent is named from the session's roster, falling back to its raw id only
 * when the roster no longer lists it.
 */
export function speakerLabel(
  agentId: string | undefined,
  fallback: string,
  names?: ReadonlyMap<string, string>,
): string {
  if (agentId === undefined || agentId === 'leader') return fallback;
  return names?.get(agentId) ?? agentId;
}

/** id → display name for a session's agents. */
export function agentNameMap(
  agents: readonly { id: string; name: string }[] | undefined,
): ReadonlyMap<string, string> {
  return new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
}

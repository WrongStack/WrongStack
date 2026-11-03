import { HUNT_COMMAND_ROUTES } from '@wrongstack/project-surfaces/lib/bug-hunt-commands';
import {
  BUG_HUNT_MODE_DESCRIPTIONS,
  BUG_HUNT_MODE_LABELS,
  BUG_HUNT_MODE_SLUGS,
  BUG_HUNT_MODES,
  type BugHuntLimit,
  type BugHuntMode,
  type BugHuntSummary,
  buildBugHuntContinuation,
  buildBugHuntMessage,
  firstHuntRoundInstruction,
  parseBugHuntMessage,
} from '@wrongstack/project-surfaces/lib/bug-hunt-message';
import type { EngineCommand } from './engine-operations';
import type { ChatMessage, EngineState } from './engine-state';

/**
 * Proof-Driven Hunts (`/bughunt`, `/sechunt`, …), as the WebUI runs them: one proven defect per
 * round, a fresh round only after the previous one finished, at most the requested number of
 * rounds. Every round's prompt carries the hunt's metadata, so the conversation itself says which
 * round is running and nothing else has to be stored.
 */

export interface HuntRequest {
  mode: BugHuntMode;
  maxBugs: BugHuntLimit;
  scope: string;
}

/** One catalog entry per hunt: its canonical command, aliases, title and description. */
export const HUNT_COMMANDS = BUG_HUNT_MODES.map((mode) => {
  const names = Object.entries(HUNT_COMMAND_ROUTES)
    .filter(([, route]) => route.mode === mode)
    .map(([name]) => name);
  const canonical = HUNT_COMMAND_ROUTES[names[0]!]!.canonicalCmd;
  return {
    mode,
    name: canonical,
    aliases: names.filter((name) => name !== canonical),
    label: BUG_HUNT_MODE_LABELS[mode],
    description: BUG_HUNT_MODE_DESCRIPTIONS[mode],
  };
});

export const huntLabel = (mode: BugHuntMode | undefined) => BUG_HUNT_MODE_LABELS[mode ?? 'bughunt'];

const summaryOf = (request: HuntRequest, currentRound: number): BugHuntSummary => ({
  scope: request.scope,
  maxBugs: request.maxBugs,
  currentRound,
  ...(request.mode === 'bughunt' ? {} : { mode: request.mode }),
});

/** The first round: the builtin protocol plus the run configuration the desktop enforces. */
function firstHuntRound(protocol: string, request: HuntRequest): string {
  return buildBugHuntMessage(
    firstHuntRoundInstruction(protocol, request, 'desktop'),
    summaryOf(request, 1),
  );
}

/** The hunt round the conversation's latest prompt started, if that prompt is one. */
export function latestHuntRound(
  messages: readonly Pick<ChatMessage, 'role' | 'text'>[],
): BugHuntSummary | undefined {
  const last = messages.findLast((message) => message.role === 'user');
  return last ? parseBugHuntMessage(last.text) : undefined;
}

/** The prompt for the round after `round`, or null when `round` was the last one. */
export function nextHuntRound(round: BugHuntSummary): string | null {
  if (round.currentRound >= round.maxBugs) return null;
  const summary = { ...round, currentRound: round.currentRound + 1 };
  return buildBugHuntMessage(buildBugHuntContinuation(summary), summary);
}

// Conversations whose hunt was told to stop: the running round finishes, no further round starts.
// Starting a hunt clears the mark.
const stopped = new Set<string>();
export const stopHunt = (sessionId: string) => void stopped.add(sessionId);
export const huntStopped = (sessionId: string) => stopped.has(sessionId);
export const clearHuntStop = (sessionId: string) => void stopped.delete(sessionId);

/**
 * Prepares a hunt's first round: turns subagents off for this conversation (keeping the read-only
 * companions), since one round must attribute one outcome to one change, then reads the
 * builtin protocol. Returns the prompt to send; throws with the reason the hunt cannot start.
 */
export async function prepareHunt(
  request: HuntRequest,
  command: EngineCommand,
  prefs: Record<string, unknown>,
): Promise<string> {
  const label = BUG_HUNT_MODE_LABELS[request.mode];
  const slug = BUG_HUNT_MODE_SLUGS[request.mode];
  if (prefs['subagentsAllowed'] !== false)
    await command('prefs.update', { subagentsAllowed: false, subagentCompanionsAllowed: true }, [
      'key.operation_result',
    ]);
  const doc = await command('prompts.content', { slug }, ['prompts.content']);
  const protocol = typeof doc['content'] === 'string' ? doc['content'].trim() : '';
  if (doc['found'] !== true || !protocol)
    throw Error(`The builtin prompt “${slug}” is not available, so ${label} did not start.`);
  return firstHuntRound(protocol, request);
}

/** Whether the conversation's hunt still has rounds to run (and was not told to stop). */
export function huntContinues(state: Pick<EngineState, 'messages' | 'sessionId'>): boolean {
  const round = latestHuntRound(state.messages);
  return Boolean(round && round.currentRound < round.maxBugs && !huntStopped(state.sessionId));
}

export const huntSlug = (mode: BugHuntMode) => BUG_HUNT_MODE_SLUGS[mode];

/**
 * `/<hunt> stop`: a running round finishes and no further round starts; a hunt waiting between
 * rounds ends. Returns what to tell the user, or null when the conversation has no hunt to stop.
 */
export function requestHuntStop(
  state: Pick<EngineState, 'messages' | 'sessionId' | 'running'>,
): string | null {
  const round = latestHuntRound(state.messages);
  if (!round || huntStopped(state.sessionId)) return null;
  if (!state.running && round.currentRound >= round.maxBugs) return null;
  stopHunt(state.sessionId);
  const at = `round ${round.currentRound}/${round.maxBugs}`;
  return state.running
    ? `${huntLabel(round.mode)} stops after ${at} finishes. Use /stop to end the running turn now.`
    : `${huntLabel(round.mode)} ended after ${at}.`;
}

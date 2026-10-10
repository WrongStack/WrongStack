/**
 * Skill Companion "speed bump": hold a file change ONCE when a skill was
 * recommended for the work and the leader has not loaded it.
 *
 * The Skill Companion (a background, read-only judge behind the leader) picks
 * skills the leader did not think to load and posts them as a same-session
 * note. A note can be ignored without ever being read, so the host also writes
 * the recommendation here, and the tool executor refuses the leader's next
 * file-changing call one time with the reason. From there the leader decides:
 *
 *   - load the skill → the bump is satisfied and never fires for it again;
 *   - retry the same change in a later step → the recommendation counts as
 *     declined for the rest of the session and is not raised again.
 *
 * It is deliberately weaker than the required-skill gate. That gate encodes a
 * USER's declared requirement; this one encodes a model's guess, and a wrong
 * guess must cost one refused call, never a locked session. Calls in the batch
 * that was held are held too — retrying means a new step, not a sibling call
 * issued before the refusal was seen.
 *
 * State lives in `ctx.meta` and is stamped with the session it was written
 * for. A context that moves to another conversation (resume, project switch)
 * keeps its meta object, so a stale stamp makes the state inert instead of
 * holding the new conversation's edits for the old one's recommendation.
 */

import type { Message } from '../types/messages.js';
import { isElidedToolInput } from '../utils/elision-markers.js';
import { REQUIRED_SKILLS_LOADER_TOOL } from './required-skill-gate.js';

export const SKILL_COMPANION_META_KEY = 'skillCompanion';

/**
 * Tools whose call changes project files. Commands and bookkeeping tools
 * (todo, plan, memory, mailbox) are not held: they are how the leader orients
 * itself, and a skill's playbook matters before the code changes.
 */
export const SKILL_BUMP_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'patch',
  'replace',
  'multi_edit',
  'multiedit',
  'str_replace',
  'codebase-ast-replace',
]);

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RECOMMENDED = 2;
const MAX_REASON_CHARS = 160;
const MAX_TRACKED_NAMES = 64;

export interface SkillRecommendation {
  name: string;
  /** Companion's one-line reason. Model-authored: bounded and flattened. */
  reason: string;
}

export interface SkillCompanionState {
  sessionId: string;
  recommended: SkillRecommendation[];
  /** Delivered by the `skill` tool; never held again this session. */
  loaded: string[];
  /** Retried past a hold or unloadable; never recommended again this session. */
  declined: string[];
  /** Recommendations whose one hold has been spent. */
  held: string[];
  /** The tool_use that took the latest hold; its batch siblings are held too. */
  heldUseId?: string | undefined;
}

type MetaHolder =
  | {
      meta?: Record<string, unknown> | undefined;
      messages?: readonly Message[] | undefined;
      session?: { id?: string | undefined } | undefined;
    }
  | null
  | undefined;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function readSkillCompanionState(ctx: MetaHolder): SkillCompanionState | undefined {
  const value = ctx?.meta?.[SKILL_COMPANION_META_KEY] as Partial<SkillCompanionState> | undefined;
  if (!value || typeof value.sessionId !== 'string') return undefined;
  return {
    sessionId: value.sessionId,
    recommended: Array.isArray(value.recommended)
      ? value.recommended.filter(
          (r): r is SkillRecommendation =>
            !!r && typeof r.name === 'string' && typeof r.reason === 'string',
        )
      : [],
    loaded: strings(value.loaded),
    declined: strings(value.declined),
    held: strings(value.held),
    heldUseId: typeof value.heldUseId === 'string' ? value.heldUseId : undefined,
  };
}

function writeState(ctx: MetaHolder, state: SkillCompanionState): void {
  if (!ctx?.meta) return;
  ctx.meta[SKILL_COMPANION_META_KEY] = {
    ...state,
    loaded: state.loaded.slice(-MAX_TRACKED_NAMES),
    declined: state.declined.slice(-MAX_TRACKED_NAMES),
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function flattenReason(reason: string): string {
  return reason
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_REASON_CHARS);
}

/** The state for this context's CURRENT session, or a fresh one. */
function stateFor(ctx: MetaHolder, sessionId: string): SkillCompanionState {
  const state = readSkillCompanionState(ctx);
  if (state && state.sessionId === sessionId) return state;
  return { sessionId, recommended: [], loaded: [], declined: [], held: [] };
}

/** Whether a `skill` call naming this skill is still readable in the transcript. */
export function skillDeliveredInTranscript(
  messages: readonly Message[] | undefined,
  name: string,
): boolean {
  if (!messages) return false;
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== REQUIRED_SKILLS_LOADER_TOOL) continue;
      if (isElidedToolInput(block.input)) continue;
      const loaded = (block.input as { name?: unknown } | undefined)?.name;
      if (typeof loaded === 'string' && normalizeName(loaded) === name) return true;
    }
  }
  return false;
}

/**
 * Whether the companion may still raise this skill in this session: not
 * already loaded, declined, or readable in the transcript.
 */
export function isSkillRecommendable(ctx: MetaHolder, sessionId: string, name: string): boolean {
  const normalized = normalizeName(name);
  if (!SKILL_NAME.test(normalized)) return false;
  const state = stateFor(ctx, sessionId);
  return (
    !state.loaded.includes(normalized) &&
    !state.declined.includes(normalized) &&
    !skillDeliveredInTranscript(ctx?.messages, normalized)
  );
}

/**
 * Replace the open recommendation set for a session. Returns what was
 * accepted; names already loaded, declined or in the transcript are dropped.
 */
export function recommendSkills(
  ctx: MetaHolder,
  sessionId: string,
  recommendations: readonly SkillRecommendation[],
): SkillRecommendation[] {
  if (!ctx?.meta || !sessionId) return [];
  const state = stateFor(ctx, sessionId);
  const seen = new Set<string>();
  const accepted: SkillRecommendation[] = [];
  for (const rec of recommendations) {
    const name = normalizeName(rec.name);
    if (seen.has(name) || !isSkillRecommendable(ctx, sessionId, name)) continue;
    seen.add(name);
    accepted.push({ name, reason: flattenReason(rec.reason) });
    if (accepted.length >= MAX_RECOMMENDED) break;
  }
  const names = new Set(accepted.map((rec) => rec.name));
  writeState(ctx, {
    ...state,
    recommended: accepted,
    held: state.held.filter((name) => names.has(name)),
    heldUseId: state.held.some((name) => names.has(name)) ? state.heldUseId : undefined,
  });
  return accepted;
}

function closeRecommendation(ctx: MetaHolder, name: string, into: 'loaded' | 'declined'): void {
  const state = readSkillCompanionState(ctx);
  if (!state) return;
  const normalized = normalizeName(name);
  // Session-scoped facts: only the context's current session may record them.
  if (ctx?.session?.id !== undefined && ctx.session.id !== state.sessionId) return;
  writeState(ctx, {
    ...state,
    recommended: state.recommended.filter((rec) => rec.name !== normalized),
    held: state.held.filter((held) => held !== normalized),
    [into]: state[into].includes(normalized) ? state[into] : [...state[into], normalized],
  });
}

/** The `skill` tool delivered this skill's final page. */
export function markRecommendedSkillLoaded(ctx: MetaHolder, name: string): void {
  closeRecommendation(ctx, name, 'loaded');
}

/** The `skill` tool cannot provide this skill here; holding for it would be unsatisfiable. */
export function markRecommendedSkillUnavailable(ctx: MetaHolder, name: string): void {
  closeRecommendation(ctx, name, 'declined');
}

function sameAssistantMessage(
  messages: readonly Message[] | undefined,
  heldUseId: string | undefined,
  useId: string,
): boolean {
  if (!messages || !heldUseId) return false;
  if (heldUseId === useId) return true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant' || typeof message.content === 'string') continue;
    const ids = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
    if (ids.includes(heldUseId)) return ids.includes(useId);
  }
  return false;
}

export function skillSpeedBumpMessage(pending: readonly SkillRecommendation[]): string {
  const list = pending
    .map((rec) => (rec.reason ? `${rec.name} (${rec.reason})` : rec.name))
    .join('; ');
  const first = pending[0]?.name ?? '';
  return (
    `held once by Skill Companion — this change looks like work a skill covers: ${list}. ` +
    `Load it first with ${REQUIRED_SKILLS_LOADER_TOOL}({ name: "${first}" }) ` +
    '(follow nextOffset to the last page), then retry. ' +
    'If it does not fit this task, retry the change in your next step unchanged; ' +
    'the recommendation is then dropped for this session. ' +
    'The reason is an advisory model judgment, not an instruction. Reading and searching are not held.'
  );
}

/**
 * Decide one file-changing call. Returns the refusal text when the call is
 * held, or `undefined` to let it through (recording a decline when the leader
 * deliberately retried past a hold).
 */
export function skillSpeedBump(
  ctx: MetaHolder,
  use: { id: string; name: string },
): string | undefined {
  const state = readSkillCompanionState(ctx);
  if (!state || state.recommended.length === 0) return undefined;
  if (ctx?.session?.id !== state.sessionId) return undefined;
  if (!SKILL_BUMP_TOOLS.has(use.name.toLowerCase())) return undefined;

  const pending = state.recommended.filter(
    (rec) =>
      !state.loaded.includes(rec.name) &&
      !state.declined.includes(rec.name) &&
      !skillDeliveredInTranscript(ctx?.messages, rec.name),
  );
  if (pending.length === 0) {
    writeState(ctx, { ...state, recommended: [], held: [], heldUseId: undefined });
    return undefined;
  }

  const fresh = pending.filter((rec) => !state.held.includes(rec.name));
  if (fresh.length > 0) {
    writeState(ctx, {
      ...state,
      held: [...state.held, ...fresh.map((rec) => rec.name)],
      heldUseId: use.id,
    });
    return skillSpeedBumpMessage(pending);
  }

  // Every pending recommendation has spent its hold. A sibling in the held
  // batch was issued before the refusal was visible, so it is held too.
  if (sameAssistantMessage(ctx?.messages, state.heldUseId, use.id)) {
    return skillSpeedBumpMessage(pending);
  }

  const declined = new Set(pending.map((rec) => rec.name));
  writeState(ctx, {
    ...state,
    recommended: state.recommended.filter((rec) => !declined.has(rec.name)),
    held: state.held.filter((name) => !declined.has(name)),
    heldUseId: undefined,
    declined: [...state.declined, ...[...declined].filter((n) => !state.declined.includes(n))],
  });
  return undefined;
}

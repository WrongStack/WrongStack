/**
 * Host-enforced "load these skills before changing anything" gate.
 *
 * A `$name` mention only asks the model to load a skill; nothing checks that
 * it did. A run whose instructions depend on a playbook — the Proof-Driven Bug
 * Hunter is the first — declares it with a marker in the user's message:
 *
 *   <!-- wrongstack:required-skills bug-hunter debugging testing -->
 *
 * From that message on, every mutating tool call is refused until each named
 * skill has been delivered to the model in full by the `skill` tool (the last
 * continuation page included), or the `skill` tool has reported it missing or
 * unavailable. Reading and searching stay allowed.
 *
 * The requirement lives in `ctx.meta`, not in the transcript. Compaction folds
 * early turns into a digest and drops tool results, so a requirement derived
 * from messages would quietly disappear in the later rounds of a long hunt.
 * Whether a loaded skill is still *read*, on the other hand, is a fact about
 * the transcript: once compaction removes or elides the call that delivered it,
 * the skill counts as pending again and has to be reloaded. `/clear` deletes
 * every meta key and so ends the gate with the conversation; resume rebuilds it
 * from the journal (`restoreRequiredSkillsFromEvents`).
 *
 * A marker can only add a restriction, and a skill the runtime cannot provide
 * is released by the failed load, so a marker naming a missing skill cannot
 * lock the session.
 *
 * The gate only binds a model whose loop WrongStack runs. An agent provider
 * that keeps its own context (ACP or WrongForge leader) loads skills with its
 * own tools and calls WrongStack's through a gateway that never writes to
 * `ctx.messages`; the executor does not gate it (tool-executor.ts), and the
 * marker stays an instruction there.
 */

import type { ContentBlock, ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { SessionEvent } from '@wrongstack/contracts/types/session-events';
import { isElidedResultContent, isElidedToolInput } from '../utils/elision-markers.js';

export const REQUIRED_SKILLS_META_KEY = 'requiredSkills';

/** The tool whose deliveries satisfy the gate. */
export const REQUIRED_SKILLS_LOADER_TOOL = 'skill';

const MARKER = /<!--\s*wrongstack:required-skills\s+([\s\S]*?)-->/g;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_REQUIRED_SKILLS = 16;

export interface RequiredSkillsState {
  required: string[];
  loaded: string[];
  unavailable: string[];
  /** Skill name → id of the `skill` call that delivered its last page. */
  deliveries: Record<string, string>;
}

type MetaHolder =
  | {
      meta?: Record<string, unknown> | undefined;
      /** When present, loaded skills are checked against it (see pending). */
      messages?: readonly Message[] | undefined;
    }
  | null
  | undefined;

/** The skills a message's marker requires, or `undefined` when it has none. */
export function parseRequiredSkillsMarker(text: string): string[] | undefined {
  const matches = text.matchAll(MARKER);
  const collected: string[] = [];
  for (const match of matches) {
    const raw = match[1] ?? '';
    const parts = raw.trim().toLowerCase().split(/\s+/);
    for (const part of parts) {
      if (SKILL_NAME.test(part) && !collected.includes(part)) {
        collected.push(part);
        if (collected.length >= MAX_REQUIRED_SKILLS) break;
      }
    }
    if (collected.length >= MAX_REQUIRED_SKILLS) break;
  }
  return collected.length > 0 ? collected : undefined;
}

export function readRequiredSkillsState(ctx: MetaHolder): RequiredSkillsState | undefined {
  const value = ctx?.meta?.[REQUIRED_SKILLS_META_KEY] as Partial<RequiredSkillsState> | undefined;
  if (!value || !Array.isArray(value.required)) return undefined;
  return {
    required: value.required,
    loaded: Array.isArray(value.loaded) ? value.loaded : [],
    unavailable: Array.isArray(value.unavailable) ? value.unavailable : [],
    deliveries:
      value.deliveries && typeof value.deliveries === 'object' ? { ...value.deliveries } : {},
  };
}

function writeState(ctx: MetaHolder, state: RequiredSkillsState): void {
  if (ctx?.meta) ctx.meta[REQUIRED_SKILLS_META_KEY] = state;
}

/**
 * Arm the gate from a user message. A new marker starts over, so every run that
 * declares the requirement loads its skills again. Returns whether it armed.
 */
export function armRequiredSkills(ctx: MetaHolder, text: string): boolean {
  const required = parseRequiredSkillsMarker(text);
  if (!required || !ctx?.meta) return false;
  writeState(ctx, { required, loaded: [], unavailable: [], deliveries: {} });
  return true;
}

/**
 * The `skill` tool delivered this skill's final body page to the model, in the
 * call `toolUseId` when known. A reload replaces the recorded delivery.
 */
export function markRequiredSkillLoaded(ctx: MetaHolder, name: string, toolUseId?: string): void {
  const state = readRequiredSkillsState(ctx);
  const normalized = name.trim().toLowerCase();
  if (!state?.required.includes(normalized)) return;
  const deliveries = { ...state.deliveries };
  if (toolUseId) deliveries[normalized] = toolUseId;
  else delete deliveries[normalized];
  const loaded = state.loaded.includes(normalized) ? state.loaded : [...state.loaded, normalized];
  const unavailable = state.unavailable.filter((u) => u !== normalized);
  writeState(ctx, { ...state, loaded, unavailable, deliveries });
}

/** The `skill` tool could not provide this skill (not found, or unavailable here). */
export function markRequiredSkillUnavailable(ctx: MetaHolder, name: string): void {
  const state = readRequiredSkillsState(ctx);
  const normalized = name.trim().toLowerCase();
  if (!state?.required.includes(normalized) || state.unavailable.includes(normalized)) return;
  writeState(ctx, { ...state, unavailable: [...state.unavailable, normalized] });
}

function loadedSkillName(block: ToolUseBlock): string | undefined {
  const name = (block.input as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name.trim().toLowerCase() : undefined;
}

/**
 * Whether the call that delivered a skill is still readable in the transcript:
 * its `skill` call is present with intact input, and its result is either
 * intact or not appended yet (the batch that made it is still running).
 * Without a recorded id — a resumed session — the latest call naming the skill
 * stands in for it.
 */
function deliveryInContext(
  messages: readonly Message[],
  name: string,
  toolUseId: string | undefined,
): boolean {
  let delivery: ToolUseBlock | undefined;
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== REQUIRED_SKILLS_LOADER_TOOL) continue;
      if (toolUseId ? block.id === toolUseId : loadedSkillName(block) === name) delivery = block;
    }
  }
  if (!delivery || isElidedToolInput(delivery.input)) return false;
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result' || block.tool_use_id !== delivery.id) continue;
      return !block.is_error && !isElidedResultContent(block.content);
    }
  }
  return true;
}

/**
 * Required skills that are neither available to the model nor known to be
 * unavailable. With a transcript to check, a loaded skill whose delivery
 * compaction has removed or elided is pending again.
 */
export function pendingRequiredSkills(ctx: MetaHolder): string[] {
  const state = readRequiredSkillsState(ctx);
  if (!state) return [];
  const messages = Array.isArray(ctx?.messages) ? ctx.messages : undefined;
  return state.required.filter((name) => {
    if (state.unavailable.includes(name)) return false;
    if (!state.loaded.includes(name)) return true;
    return messages ? !deliveryInContext(messages, name, state.deliveries[name]) : false;
  });
}

/** The reason a mutating call is refused; the executor prefixes the tool name. */
export function requiredSkillsDeniedMessage(pending: readonly string[]): string {
  return (
    'this run requires skills that are not loaded, or whose text compaction has ' +
    `since removed from context: ${pending.join(', ')}. ` +
    `Load each with the ${REQUIRED_SKILLS_LOADER_TOOL} tool ` +
    `(${REQUIRED_SKILLS_LOADER_TOOL}({ name }), following nextOffset to the last page), ` +
    'then retry. Reading and searching are not blocked.'
  );
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Rebuild the gate for the session a context now belongs to: the last marker in
 * the user's input arms it and the skills activated after that marker count as
 * loaded. A context that moves to another session keeps its `meta`, so the
 * previous session's gate is dropped first; restoring from no events (a fresh
 * session) just clears it. The journal records an activation per `skill` call,
 * not per page, so a skill whose later pages were never read counts as loaded
 * after a resume.
 */
export function restoreRequiredSkillsFromEvents(
  ctx: MetaHolder,
  events: readonly SessionEvent[] | undefined,
): void {
  if (!ctx?.meta) return;
  delete ctx.meta[REQUIRED_SKILLS_META_KEY];
  for (const event of events ?? []) {
    if (event.type === 'user_input') armRequiredSkills(ctx, textOf(event.content));
    else if (event.type === 'skill_activated') markRequiredSkillLoaded(ctx, event.skillName);
  }
}

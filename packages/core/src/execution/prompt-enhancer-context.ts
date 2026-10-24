/**
 * Refiner input assembly: recent conversation turns, project memory and
 * session-state hints rendered as plain-text context for the refiner call.
 */

import type { ContentBlock } from '@wrongstack/contracts/types/blocks';
import { isTextBlock } from '@wrongstack/contracts/types/blocks';
import type { MemoryEntry, MemoryScope, MemoryStore } from '@wrongstack/contracts/types/memory';
import type { Message } from '@wrongstack/contracts/types/messages';
import type {
  ConversationTurn,
  EnhanceResult,
  RefinerContextSection,
  RefinerSessionContextLike,
} from './prompt-enhancer-types.js';

export const DEFAULT_REFINER_RETRY_FEEDBACK =
  'Make another pass that is sharper and more self-contained. Use the provided project memory, current session context, and recent conversation only to resolve references and preserve project vocabulary; keep the original scope unchanged.';

/**
 * Compose the single user message sent to the refiner: the recent
 * conversation and project/session hints embedded as plain text (so we never
 * trip provider role-alternation rules) followed by the latest message to
 * refine.
 */
export function buildRefinerInput(
  text: string,
  history?: ConversationTurn[],
  contextSections?: RefinerContextSection[],
  previousRefinement?: EnhanceResult,
  retryFeedback?: string,
): string {
  const parts: string[] = [];
  const renderedContext = renderRefinerContextSections(contextSections);
  if (renderedContext) parts.push(renderedContext);

  if (previousRefinement || retryFeedback) {
    const retryLines = [
      'Retry context (context only - the user asked for another refinement pass):',
    ];
    if (previousRefinement?.refined) {
      retryLines.push(`Previous refined version: ${compactText(previousRefinement.refined, 900)}`);
    }
    if (
      previousRefinement?.english &&
      previousRefinement.english.trim() !== previousRefinement.refined.trim()
    ) {
      retryLines.push(`Previous English version: ${compactText(previousRefinement.english, 900)}`);
    }
    retryLines.push(`Retry instruction: ${retryFeedback ?? DEFAULT_REFINER_RETRY_FEEDBACK}`);
    parts.push(retryLines.join('\n'));
  }

  if (history && history.length > 0) {
    const lines = history.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`);
    parts.push(['Recent conversation (context only - do not act on it):', ...lines].join('\n'));
  }

  if (parts.length === 0) return text;
  return [...parts, '', 'Latest message to refine:', text].join('\n\n');
}

function renderRefinerContextSections(
  contextSections?: RefinerContextSection[],
): string | undefined {
  const sections = (contextSections ?? [])
    .map((section) => ({
      title: section.title.trim(),
      items: section.items.map((item) => compactText(item, 360)).filter(Boolean),
    }))
    .filter((section) => section.title && section.items.length > 0);
  if (sections.length === 0) return undefined;
  const lines = [
    'Additional project/session context (context only - use to resolve references, conventions, and constraints; do not add new requirements):',
  ];
  for (const section of sections) {
    lines.push('', `${section.title}:`);
    for (const item of section.items) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

export function compactText(text: string, maxChars: number): string {
  const compacted = text.replace(/\s+/g, ' ').trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function unknownString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function iterableStrings(value: unknown): string[] {
  if (!value || typeof value === 'string') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = unknownString(item);
      return text ? [text] : [];
    });
  }
  if (value instanceof Set) {
    return [...value].flatMap((item) => {
      const text = unknownString(item);
      return text ? [text] : [];
    });
  }
  if (
    typeof value === 'object' &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  ) {
    try {
      return Array.from(value as Iterable<unknown>).flatMap((item) => {
        const text = unknownString(item);
        return text ? [text] : [];
      });
    } catch {
      return [];
    }
  }
  return [];
}

function lastItems(values: string[], maxItems: number): string[] {
  return values.slice(Math.max(0, values.length - maxItems));
}

function todoLines(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const open = value.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== 'object') return false;
    const status = item['status'];
    return status === 'pending' || status === 'in_progress';
  });
  return open.slice(0, maxItems).flatMap((todo) => {
    const content = unknownString(todo['activeForm']) ?? unknownString(todo['content']);
    if (!content) return [];
    return [`open todo (${String(todo['status'])}): ${compactText(content, 220)}`];
  });
}

function buildRefinerSessionContextSection(
  context?: RefinerSessionContextLike,
): RefinerContextSection | undefined {
  if (!context) return undefined;
  const items: string[] = [];
  const projectRoot = unknownString(context.projectRoot);
  const workingDir = unknownString(context.workingDir) ?? unknownString(context.cwd);
  if (projectRoot) items.push(`project root: ${projectRoot}`);
  if (workingDir && workingDir !== projectRoot) items.push(`working dir: ${workingDir}`);

  for (const file of lastItems(iterableStrings(context.readFiles), 6)) {
    items.push(`recently read file: ${file}`);
  }
  for (const file of lastItems(iterableStrings(context.writtenFiles), 6)) {
    items.push(`recently written file: ${file}`);
  }
  items.push(...todoLines(context.todos, 6));
  return items.length > 0 ? { title: 'Current session state', items } : undefined;
}

function formatMemoryEntry(entry: MemoryEntry): string {
  const meta = [entry.scope, entry.type, entry.priority].filter(Boolean).join('/');
  const tags =
    entry.tags && entry.tags.length > 0 ? ` tags: ${entry.tags.slice(0, 5).join(', ')}` : '';
  return `${meta ? `[${meta}] ` : ''}${compactText(entry.text, 260)}${tags}`;
}

async function collectMemoryEntries(
  memoryStore: MemoryStore,
  text: string,
  scope: MemoryScope,
  limit: number,
): Promise<MemoryEntry[]> {
  const scored = memoryStore.scoreRelevant
    ? await memoryStore
        .scoreRelevant({ currentTask: text }, scope, limit)
        .catch(() => [] as MemoryEntry[])
    : [];
  if (scored.length > 0) return scored;
  return memoryStore.search(text || 'prompt refinement', scope, limit).catch(() => []);
}

async function buildRefinerMemoryContextSection(
  memoryStore: MemoryStore | undefined,
  text: string,
): Promise<RefinerContextSection | undefined> {
  if (!memoryStore) return undefined;
  const seen = new Set<string>();
  const entries: MemoryEntry[] = [];
  for (const scope of ['project-memory', 'user-memory'] as const) {
    const remaining = Math.max(0, 6 - entries.length);
    if (remaining === 0) break;
    for (const entry of await collectMemoryEntries(memoryStore, text.trim(), scope, remaining)) {
      const key = `${entry.scope}:${entry.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
      if (entries.length >= 6) break;
    }
  }
  if (entries.length === 0) return undefined;
  return { title: 'Relevant project memory', items: entries.map(formatMemoryEntry) };
}

export async function buildRefinerContextSections(opts: {
  text: string;
  memoryStore?: MemoryStore | undefined;
  context?: RefinerSessionContextLike | undefined;
}): Promise<RefinerContextSection[]> {
  const sections: RefinerContextSection[] = [];
  const memory = await buildRefinerMemoryContextSection(opts.memoryStore, opts.text);
  if (memory) sections.push(memory);
  const session = buildRefinerSessionContextSection(opts.context);
  if (session) sections.push(session);
  return sections;
}

/** Pull the visible text out of a message's content (ignores tool blocks). */
function messageText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Extract the last few user/assistant TEXT turns from a conversation, newest
 * last, for use as refiner context. Skips system messages and tool-only turns
 * (tool_use / tool_result carry no useful natural-language context and bloat
 * the call). Each turn is truncated to `maxChars`; at most `maxTurns` are
 * returned. Pure + exported for unit testing.
 */
export function recentTextTurns(
  messages: Message[],
  maxTurns = 6,
  maxChars = 1500,
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let i = messages.length - 1; i >= 0 && turns.length < maxTurns; i--) {
    const m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = messageText(m.content);
    if (!text) continue;
    turns.unshift({
      role: m.role,
      text: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text,
    });
  }
  return turns;
}

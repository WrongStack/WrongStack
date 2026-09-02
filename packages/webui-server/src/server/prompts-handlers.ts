/**
 * Shared prompt-library WebSocket handlers for BOTH the standalone WebUI server
 * (`packages/webui/src/server/index.ts`) and the CLI's `--webui` embedded server
 * (`packages/cli/src/webui-server.ts`). One source of truth so the two servers
 * never drift (the lesson from skills-handlers).
 *
 * Each function handles one request→response cycle; callers drop them into their
 * switch:
 *
 *   case 'prompts.search': return handlePromptsSearch(ws, promptsCtx, msg);
 *
 * The prompt library is read across three layers (builtin + user + project) by
 * the injected `PromptLoader`; writes (create/favorite) go to the user layer
 * with copy-on-write for builtins. Treat synced/builtin content as DATA — these
 * handlers never execute it; the client inserts a chosen prompt into the chat
 * input as an ordinary user turn.
 */

import { getPromptJournalEntries, type PromptJournalFilter } from '@wrongstack/core/prompts';
import type { PromptUsageStore } from '@wrongstack/core/storage';
import type { PromptEntry, PromptLoader, PromptVariable } from '@wrongstack/core/types';
import { errMessage, send } from './ws-utils.js';

/**
 * Normalize a client-supplied `variables` array into clean PromptVariable[].
 * Drops entries without a string `name`; carries description/required/multiline
 * and a string-only `enum`. Returns undefined when nothing valid is present so
 * the entry omits the field entirely.
 */
function parseVariablesPayload(raw: unknown): PromptVariable[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PromptVariable[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o['name'] !== 'string' || !o['name'].trim()) continue;
    const enumVals =
      Array.isArray(o['enum']) && o['enum'].every((x) => typeof x === 'string')
        ? (o['enum'] as string[]).map((s) => s.trim()).filter(Boolean)
        : undefined;
    const v: PromptVariable = { name: o['name'].trim() };
    if (typeof o['description'] === 'string' && o['description'].trim()) {
      v.description = o['description'].trim();
    }
    if (o['required'] === true) v.required = true;
    if (o['multiline'] === true) v.multiline = true;
    if (enumVals && enumVals.length > 0) v.enum = enumVals;
    out.push(v);
  }
  return out.length > 0 ? out : undefined;
}

export interface PromptsContext {
  /** Backs all prompt ops. Absent ⇒ feature unavailable. */
  promptLoader: PromptLoader | undefined;
  /** Records per-slug insert counts (shared with CLI `/prompt recent`). */
  promptUsage?: PromptUsageStore | undefined;
}

/** Project-relative, content-free metadata for list/search results. */
function toMeta(e: PromptEntry) {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    description: e.description,
    category: e.category,
    tags: e.tags,
    source: e.source,
    favorite: e.favorite,
    variables: e.variables ?? [],
  };
}

export async function handlePromptsList(ws: WSLike, ctx: PromptsContext): Promise<void> {
  if (!ctx.promptLoader) {
    send(ws, { type: 'prompts.list', payload: { enabled: false, prompts: [], categories: [] } });
    return;
  }
  try {
    const [all, categories] = await Promise.all([
      ctx.promptLoader.list(),
      ctx.promptLoader.categories(),
    ]);
    send(ws, {
      type: 'prompts.list',
      payload: { enabled: true, prompts: all.map(toMeta), categories },
    });
  } catch (err) {
    send(ws, {
      type: 'prompts.list',
      payload: { enabled: true, prompts: [], categories: [], error: errMessage(err) },
    });
  }
}

export async function handlePromptsSearch(
  ws: WSLike,
  ctx: PromptsContext,
  msg: unknown,
): Promise<void> {
  if (!ctx.promptLoader) {
    send(ws, { type: 'prompts.search', payload: { enabled: false, prompts: [] } });
    return;
  }
  const payload = (msg as { payload?: { query?: string; category?: string } }).payload ?? {};
  try {
    const results = await ctx.promptLoader.search(payload.query ?? '', {
      ...(payload.category ? { category: payload.category } : {}),
      limit: 50,
    });
    send(ws, { type: 'prompts.search', payload: { enabled: true, prompts: results.map(toMeta) } });
  } catch (err) {
    send(ws, {
      type: 'prompts.search',
      payload: { enabled: true, prompts: [], error: errMessage(err) },
    });
  }
}

export async function handlePromptsContent(
  ws: WSLike,
  ctx: PromptsContext,
  msg: unknown,
): Promise<void> {
  const slug = (msg as { payload?: { slug?: string } }).payload?.slug;
  if (!ctx.promptLoader || !slug) {
    send(ws, {
      type: 'prompts.content',
      payload: { slug: slug ?? '', found: false, content: '', variables: [] },
    });
    return;
  }
  try {
    const entry = await ctx.promptLoader.find(slug);
    if (!entry) {
      send(ws, {
        type: 'prompts.content',
        payload: { slug, found: false, content: '', variables: [] },
      });
      return;
    }
    send(ws, {
      type: 'prompts.content',
      payload: {
        slug: entry.slug,
        found: true,
        title: entry.title,
        content: entry.content,
        variables: entry.variables ?? [],
        category: entry.category,
        source: entry.source,
      },
    });
  } catch (err) {
    send(ws, {
      type: 'prompts.content',
      payload: { slug, found: false, content: '', variables: [], error: errMessage(err) },
    });
  }
}

export async function handlePromptsFavorite(
  ws: WSLike,
  ctx: PromptsContext,
  msg: unknown,
): Promise<void> {
  const payload = (msg as { payload?: { slug?: string; favorite?: boolean } }).payload;
  if (!ctx.promptLoader || !payload?.slug) {
    send(ws, {
      type: 'prompts.favorite',
      payload: { success: false, error: 'Prompt library unavailable' },
    });
    return;
  }
  try {
    const updated = await ctx.promptLoader.setFavorite(payload.slug, payload.favorite !== false);
    if (!updated) {
      send(ws, {
        type: 'prompts.favorite',
        payload: { success: false, error: 'Prompt not found' },
      });
      return;
    }
    send(ws, {
      type: 'prompts.favorite',
      payload: { success: true, slug: updated.slug, favorite: updated.favorite },
    });
  } catch (err) {
    send(ws, { type: 'prompts.favorite', payload: { success: false, error: errMessage(err) } });
  }
}

export async function handlePromptsCreate(
  ws: WSLike,
  ctx: PromptsContext,
  msg: unknown,
): Promise<void> {
  const p = (msg as { payload?: Record<string, unknown> }).payload;
  if (!ctx.promptLoader || !p) {
    send(ws, {
      type: 'prompts.created',
      payload: { success: false, error: 'Prompt library unavailable' },
    });
    return;
  }
  const title = typeof p['title'] === 'string' ? p['title'].trim() : '';
  const content = typeof p['content'] === 'string' ? p['content'] : '';
  if (!title || !content) {
    send(ws, {
      type: 'prompts.created',
      payload: { success: false, error: 'Title and content are required' },
    });
    return;
  }
  try {
    const now = new Date().toISOString();
    const tags = Array.isArray(p['tags'])
      ? (p['tags'].filter((t) => typeof t === 'string') as string[])
      : [];
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'prompt';
    const variables = parseVariablesPayload(p['variables']);
    const entry: PromptEntry = {
      id: slug,
      slug,
      title,
      description: typeof p['description'] === 'string' ? p['description'] : '',
      content,
      category:
        typeof p['category'] === 'string' && p['category']
          ? (p['category'] as string)
          : 'uncategorized',
      tags,
      source: 'user',
      favorite: false,
      ...(variables ? { variables } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.promptLoader.save(entry);
    send(ws, { type: 'prompts.created', payload: { success: true, slug } });
  } catch (err) {
    send(ws, { type: 'prompts.created', payload: { success: false, error: errMessage(err) } });
  }
}

/** Record that a prompt was inserted (best-effort; feeds CLI `/prompt recent`). */
export async function handlePromptsUsed(
  ws: WSLike,
  ctx: PromptsContext,
  msg: unknown,
): Promise<void> {
  const slug = (msg as { payload?: { slug?: string } }).payload?.slug;
  if (!ctx.promptUsage || !slug) {
    send(ws, { type: 'prompts.used', payload: { success: false } });
    return;
  }
  try {
    await ctx.promptUsage.record(slug);
    send(ws, { type: 'prompts.used', payload: { success: true, slug } });
  } catch {
    send(ws, { type: 'prompts.used', payload: { success: false } });
  }
}

/** Return recently-inserted prompt slugs (most-recent first) for the modal's Recent view. */
export async function handlePromptsRecent(ws: WSLike, ctx: PromptsContext): Promise<void> {
  if (!ctx.promptUsage) {
    send(ws, { type: 'prompts.recent', payload: { slugs: [] } });
    return;
  }
  try {
    const recent = await ctx.promptUsage.recent(50);
    send(ws, { type: 'prompts.recent', payload: { slugs: recent.map((r) => r.slug) } });
  } catch (err) {
    send(ws, { type: 'prompts.recent', payload: { slugs: [], error: errMessage(err) } });
  }
}

/** Read the project's hierarchical prompt journal (`<projectRoot>/.wrongstack/prompts/`). */
export async function handlePromptsJournal(
  ws: WSLike,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  if (!projectRoot) {
    send(ws, { type: 'prompts.journal', payload: { enabled: false, entries: [] } });
    return;
  }
  const payload = (msg as { payload?: { filter?: PromptJournalFilter } | undefined }).payload;
  try {
    const entries = await getPromptJournalEntries(projectRoot, {
      ...(payload?.filter ?? {}),
      limit: payload?.filter?.limit ?? 200,
    });
    send(ws, { type: 'prompts.journal', payload: { enabled: true, entries } });
  } catch (err) {
    send(ws, {
      type: 'prompts.journal',
      payload: { enabled: true, entries: [], error: errMessage(err) },
    });
  }
}

/** Minimal structural type for the ws.send sink (matches `ws` WebSocket). */
type WSLike = Parameters<typeof send>[0];

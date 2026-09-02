/**
 * Unit tests for the shared prompt-library WebSocket handlers
 * (`packages/webui/src/server/prompts-handlers.ts`), which back BOTH the
 * standalone WebUI server and the CLI's `--webui` embedded server.
 *
 * Each test drives a handler with a stub PromptsContext (a fake PromptLoader +
 * a capturing `send`) — no real I/O, no socket.
 */

import type { PromptEntry, PromptLoader } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handlePromptsContent,
  handlePromptsCreate,
  handlePromptsFavorite,
  handlePromptsList,
  handlePromptsSearch,
  handlePromptsUsed,
  handlePromptsRecent,
  type PromptsContext,
} from '@wrongstack/webui-server';
import type { WSServerMessage } from '../../src/types.js';

function entry(slug: string, over: Partial<PromptEntry> = {}): PromptEntry {
  const now = new Date(0).toISOString();
  return {
    id: slug,
    slug,
    title: over.title ?? slug,
    description: over.description ?? '',
    content: over.content ?? `body ${slug}`,
    category: over.category ?? 'coding',
    tags: over.tags ?? [],
    source: over.source ?? 'builtin',
    favorite: over.favorite ?? false,
    variables: over.variables,
    createdAt: now,
    updatedAt: now,
  };
}

function fakeLoader(
  prompts: PromptEntry[],
): PromptLoader & { saved: PromptEntry[]; favorited: string[] } {
  const saved: PromptEntry[] = [];
  const favorited: string[] = [];
  return {
    saved,
    favorited,
    async list() {
      return prompts;
    },
    async find(s: string) {
      return prompts.find((p) => p.slug === s || p.id === s);
    },
    async search(q: string) {
      return prompts.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()));
    },
    async categories() {
      return [{ id: 'coding', label: 'Coding', count: prompts.length }];
    },
    async save(e: PromptEntry) {
      saved.push(e);
    },
    async delete() {
      return true;
    },
    async setFavorite(s: string, fav: boolean) {
      favorited.push(s);
      const found = prompts.find((p) => p.slug === s);
      return found ? { ...found, favorite: fav, source: 'user' as const } : undefined;
    },
    invalidateCache() {},
  };
}

function openWs(): { ws: WebSocket; messages: WSServerMessage[] } {
  const messages: WSServerMessage[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => messages.push(JSON.parse(raw) as WSServerMessage),
  } as never as WebSocket;
  return { ws, messages };
}

const payloadOf = (msgs: WSServerMessage[], type: string) =>
  msgs.find((m) => m.type === type)?.payload as Record<string, unknown> | undefined;

describe('handlePromptsList', () => {
  it('reports disabled when no loader is wired', async () => {
    const { ws, messages } = openWs();
    await handlePromptsList(ws, { promptLoader: undefined } as PromptsContext);
    expect(payloadOf(messages, 'prompts.list')).toMatchObject({ enabled: false, prompts: [] });
  });

  it('returns content-free metadata and categories', async () => {
    const { ws, messages } = openWs();
    await handlePromptsList(ws, { promptLoader: fakeLoader([entry('a', { title: 'Alpha' })]) });
    const p = payloadOf(messages, 'prompts.list')!;
    expect(p['enabled']).toBe(true);
    expect((p['prompts'] as unknown[]).length).toBe(1);
    expect((p['prompts'] as Record<string, unknown>[])[0]).not.toHaveProperty('content');
    expect((p['categories'] as unknown[]).length).toBe(1);
  });
});

describe('handlePromptsSearch', () => {
  it('filters by query', async () => {
    const { ws, messages } = openWs();
    const loader = fakeLoader([entry('a', { title: 'Deploy' }), entry('b', { title: 'Review' })]);
    await handlePromptsSearch(ws, { promptLoader: loader }, { payload: { query: 'deploy' } });
    const p = payloadOf(messages, 'prompts.search')!;
    expect((p['prompts'] as Record<string, unknown>[]).map((x) => x['title'])).toEqual(['Deploy']);
  });
});

describe('handlePromptsContent', () => {
  it('returns full content + variables for a slug', async () => {
    const { ws, messages } = openWs();
    const loader = fakeLoader([
      entry('tmpl', { content: 'Hi {{name}}', variables: [{ name: 'name', required: true }] }),
    ]);
    await handlePromptsContent(ws, { promptLoader: loader }, { payload: { slug: 'tmpl' } });
    const p = payloadOf(messages, 'prompts.content')!;
    expect(p).toMatchObject({ found: true, content: 'Hi {{name}}' });
    expect((p['variables'] as unknown[]).length).toBe(1);
  });

  it('reports not found for an unknown slug', async () => {
    const { ws, messages } = openWs();
    await handlePromptsContent(ws, { promptLoader: fakeLoader([]) }, { payload: { slug: 'nope' } });
    expect(payloadOf(messages, 'prompts.content')).toMatchObject({ found: false });
  });
});

describe('handlePromptsFavorite', () => {
  it('favorites via the loader (copy-on-write for builtins)', async () => {
    const { ws, messages } = openWs();
    const loader = fakeLoader([entry('fav', { source: 'builtin' })]);
    await handlePromptsFavorite(
      ws,
      { promptLoader: loader },
      { payload: { slug: 'fav', favorite: true } },
    );
    expect(loader.favorited).toEqual(['fav']);
    expect(payloadOf(messages, 'prompts.favorite')).toMatchObject({
      success: true,
      favorite: true,
    });
  });
});

describe('handlePromptsUsed', () => {
  it('records usage via the usage store', async () => {
    const { ws, messages } = openWs();
    const recorded: string[] = [];
    const promptUsage = { record: async (slug: string) => recorded.push(slug) } as never;
    await handlePromptsUsed(
      ws,
      { promptLoader: fakeLoader([]), promptUsage },
      { payload: { slug: 'x' } },
    );
    expect(recorded).toEqual(['x']);
    expect(payloadOf(messages, 'prompts.used')).toMatchObject({ success: true, slug: 'x' });
  });

  it('reports failure when no usage store is wired', async () => {
    const { ws, messages } = openWs();
    await handlePromptsUsed(ws, { promptLoader: fakeLoader([]) }, { payload: { slug: 'x' } });
    expect(payloadOf(messages, 'prompts.used')).toMatchObject({ success: false });
  });
});

describe('handlePromptsRecent', () => {
  it('returns recent slugs from the usage store', async () => {
    const { ws, messages } = openWs();
    const promptUsage = { recent: async () => [{ slug: 'b' }, { slug: 'a' }] } as never;
    await handlePromptsRecent(ws, { promptLoader: fakeLoader([]), promptUsage });
    expect(payloadOf(messages, 'prompts.recent')).toMatchObject({ slugs: ['b', 'a'] });
  });

  it('returns an empty list when no usage store is wired', async () => {
    const { ws, messages } = openWs();
    await handlePromptsRecent(ws, { promptLoader: fakeLoader([]) });
    expect(payloadOf(messages, 'prompts.recent')).toMatchObject({ slugs: [] });
  });
});

describe('handlePromptsCreate', () => {
  it('saves a new user prompt and returns its slug', async () => {
    const { ws, messages } = openWs();
    const loader = fakeLoader([]);
    await handlePromptsCreate(
      ws,
      { promptLoader: loader },
      {
        payload: { title: 'My New Prompt', content: 'do {{x}}', category: 'coding', tags: ['t'] },
      },
    );
    expect(payloadOf(messages, 'prompts.created')).toMatchObject({
      success: true,
      slug: 'my-new-prompt',
    });
    expect(loader.saved[0]).toMatchObject({
      slug: 'my-new-prompt',
      source: 'user',
      category: 'coding',
    });
  });

  it('rejects missing title/content', async () => {
    const { ws, messages } = openWs();
    await handlePromptsCreate(
      ws,
      { promptLoader: fakeLoader([]) },
      { payload: { title: '', content: '' } },
    );
    expect(payloadOf(messages, 'prompts.created')).toMatchObject({ success: false });
  });

  it('persists rich variables (enum + multiline) from the create payload', async () => {
    const { ws } = openWs();
    const loader = fakeLoader([]);
    await handlePromptsCreate(
      ws,
      { promptLoader: loader },
      {
        payload: {
          title: 'Rich',
          content: 'Use {{flavor}} on {{code}}',
          variables: [
            { name: 'flavor', required: true, enum: ['PCRE', 'JS'] },
            { name: 'code', required: true, multiline: true },
            { name: '', description: 'dropped — no name' },
          ],
        },
      },
    );
    expect(loader.saved[0]?.variables).toEqual([
      { name: 'flavor', required: true, enum: ['PCRE', 'JS'] },
      { name: 'code', required: true, multiline: true },
    ]);
  });
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordPromptJournalEntry } from '@wrongstack/core/prompts';
import { describe, expect, it, vi } from 'vitest';
import {
  handlePromptsContent,
  handlePromptsCreate,
  handlePromptsFavorite,
  handlePromptsJournal,
  handlePromptsSearch,
  handlePromptsUsed,
  type PromptsContext,
} from '../src/server/prompts-handlers.js';
import { WebSocket } from '../src/ws-runtime.js';

function fakeWs() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as unknown as WebSocket;
  return { ws, sent };
}

describe('prompts-handlers payload validation and null safety', () => {
  it('rejects non-string slug/query/category and non-object payloads without calling loader or usage', async () => {
    const find = vi.fn();
    const setFavorite = vi.fn();
    const save = vi.fn();
    const search = vi.fn(async () => []);
    const record = vi.fn();

    const ctx: PromptsContext = {
      promptLoader: {
        list: async () => [],
        find,
        search,
        categories: async () => [],
        save,
        delete: async () => true,
        setFavorite,
        invalidateCache() {},
      } as never,
      promptUsage: {
        record,
        recent: async () => [],
      } as never,
    };

    const { ws, sent } = fakeWs();
    await handlePromptsSearch(ws, ctx, { payload: { requestId: 's1', query: 123, category: [] } });
    await handlePromptsContent(ws, ctx, { payload: { requestId: 'c1', slug: { bad: true } } });
    await handlePromptsFavorite(ws, ctx, { payload: { requestId: 'f1', slug: 42 } });
    await handlePromptsCreate(ws, ctx, { payload: ['not-an-object'] });
    await handlePromptsUsed(ws, ctx, { payload: { requestId: 'u1', slug: true } });

    expect(search).toHaveBeenCalledWith('', { limit: 50 });
    expect(find).not.toHaveBeenCalled();
    expect(setFavorite).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(sent[0]?.payload).toMatchObject({ requestId: 's1', enabled: true, prompts: [] });
    expect(sent[1]?.payload).toMatchObject({ requestId: 'c1', found: false });
    expect(sent[2]?.payload).toMatchObject({ requestId: 'f1', success: false });
    expect(sent[3]?.payload).toMatchObject({ success: false });
    expect(sent[4]?.payload).toMatchObject({ requestId: 'u1', success: false });
  });

  it('handles null messages safely across all handlers', async () => {
    const ctx: PromptsContext = {
      promptLoader: {
        list: async () => [],
        find: async () => undefined,
        search: async () => [],
        categories: async () => [],
        save: async () => {},
        delete: async () => true,
        setFavorite: async () => undefined,
        invalidateCache() {},
      } as never,
      promptUsage: {
        record: async () => {},
        recent: async () => [],
      } as never,
    };
    const { ws, sent } = fakeWs();
    await handlePromptsSearch(ws, ctx, null);
    await handlePromptsContent(ws, ctx, null);
    await handlePromptsFavorite(ws, ctx, null);
    await handlePromptsCreate(ws, ctx, null);
    await handlePromptsUsed(ws, ctx, null);
    await handlePromptsJournal(ws, null, '');
    expect(sent).toHaveLength(6);
  });

  it('rejects non-object journal filter and serves valid filters with clamped limits', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompts-journal-filter-'));
    try {
      await recordPromptJournalEntry({
        projectRoot: tmpDir,
        sessionId: 'sess-1',
        category: 'raw_user',
        content: 'Hello world',
      });
      const { ws, sent } = fakeWs();
      await handlePromptsJournal(ws, { payload: { requestId: 'j1', filter: 'bad' } }, tmpDir);
      expect(sent[0]?.payload).toMatchObject({
        requestId: 'j1',
        enabled: true,
        entries: [],
        error: 'filter must be a plain object',
      });

      await handlePromptsJournal(
        ws,
        { payload: { requestId: 'j2', filter: { sessionId: 'sess-1', limit: 999999 } } },
        tmpDir,
      );
      expect(sent[1]?.payload).toMatchObject({
        requestId: 'j2',
        enabled: true,
      });
      expect(sent[1]?.payload['entries']).toHaveLength(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

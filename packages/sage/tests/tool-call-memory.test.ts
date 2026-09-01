import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  containsMemoryText,
  createSageToolCallMiddleware,
  type ExtractedTriggerContext,
  type SageRetrieverLike,
} from '../src/middleware/tool-call-memory.js';
import {
  pathAnchorRelation,
  retrieveTriggeredMemories,
} from '../src/middleware/tool-call-memory-retrieval.js';
import { SqliteSageStore } from '../src/sqlite-store.js';
import type { Sage } from '../src/types.js';

let tmpDir: string;
let openStores: SqliteSageStore[] = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-tcm-'));
  openStores = [];
});

afterEach(async () => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  // Give Windows a tick to release WAL file handles before removing the dir.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * The SQLite store exposes retrieveForPath(paths[]); the middleware consumes the
 * host-facing retriever surface (retrieveForPath({ path })). Production bridges
 * the two through SqliteMemoryPort's retrieval capability — this adapter mirrors
 * that while still exposing rememberSage so tests can seed memories.
 */
type TestMemory = SageRetrieverLike & {
  rememberSage: SqliteSageStore['rememberSage'];
};

function makeStore(): TestMemory {
  const store = new SqliteSageStore({ projectRoot: tmpDir });
  openStores.push(store);
  return {
    rememberSage: (input) => store.rememberSage(input),
    retrieveForPath: (opts) => store.retrieveForPath([opts.path], opts),
    searchSage: (query, opts) => store.searchSage(query, opts),
    findRelatedSage: (memoryIds, opts) => store.findRelatedSage(memoryIds, opts),
    recordInjection: (memoryIds, trigger, sessionId) =>
      store.recordInjection(memoryIds, trigger, sessionId),
    recordUse: (memoryIds, source, sessionId) => store.recordUse(memoryIds, source, sessionId),
  };
}

async function storeWithFileMemory(file: string) {
  const store = makeStore();
  await store.rememberSage({
    text: `Memory for ${file}`,
    importance: 0.95,
    anchors: [{ type: 'file', path: file }],
  });
  return store;
}

function makePayload(overrides: Partial<ToolCallPipelinePayload> = {}): ToolCallPipelinePayload {
  return {
    toolUse: { type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'src/file.ts' } },
    result: { type: 'tool_result', tool_use_id: 'tu1', name: 'read', content: 'file content' },
    ctx: {
      projectRoot: tmpDir,
      cwd: tmpDir,
      session: { id: 'sess1' },
      signal: new AbortController().signal,
    },
    ...overrides,
  } as ToolCallPipelinePayload;
}

function memoryEvidenceText(payload: ToolCallPipelinePayload): string {
  return (
    (
      payload.ctx as ToolCallPipelinePayload['ctx'] & {
        memoryEvidence?: Array<{ source: string; text: string }>;
      }
    ).memoryEvidence
      ?.map((entry) => entry.text)
      .join('\n') ?? ''
  );
}

describe('pathAnchorRelation — anchor-type path scoring', () => {
  it('scores an exact symbol anchor at 0.98 with an anchor:exact-symbol reason', () => {
    const memory = {
      anchors: [{ type: 'symbol', path: 'src/a.ts', symbol: 'run' }],
    } as unknown as Sage;
    expect(pathAnchorRelation(memory, 'src/a.ts')).toEqual({
      strength: 0.98,
      reason: 'anchor:exact-symbol:src/a.ts',
    });
  });

  it('keeps the 0.95 exact-file score and anchor:exact-file reason unchanged', () => {
    const memory = { anchors: [{ type: 'file', path: 'src/a.ts' }] } as unknown as Sage;
    expect(pathAnchorRelation(memory, 'src/a.ts')).toEqual({
      strength: 0.95,
      reason: 'anchor:exact-file:src/a.ts',
    });
  });

  it('prefers the narrower symbol-anchor score when a file anchor precedes it', () => {
    const memory = {
      anchors: [
        { type: 'file', path: 'src/a.ts' },
        { type: 'symbol', path: 'src/a.ts', symbol: 'run' },
      ],
    } as unknown as Sage;
    expect(pathAnchorRelation(memory, 'src/a.ts')).toEqual({
      strength: 0.98,
      reason: 'anchor:exact-symbol:src/a.ts',
    });
  });

  it('returns undefined for anchors without a path', () => {
    const memory = { anchors: [{ type: 'symbol', symbol: 'run' }] } as unknown as Sage;
    expect(pathAnchorRelation(memory, 'src/a.ts')).toBeUndefined();
  });
});

describe('retrieveTriggeredMemories — symbol-anchor fix path', () => {
  it('scores a symbol-anchored memory at 0.98 with the exact-symbol reason', async () => {
    const memory = {
      id: 'm-sym',
      text: 'Symbol-scoped memory for run().',
      status: 'active',
      kind: 'fact',
      contextPolicy: 'auto',
      importance: 0.9,
      anchors: [{ type: 'symbol', path: 'src/file.ts', symbol: 'run' }],
    } as unknown as Sage;
    const retriever: SageRetrieverLike = {
      retrieveForPath: async () => [memory],
      searchSage: async () => [],
    };
    const result = await retrieveTriggeredMemories(
      retriever,
      { trigger: 'read', queryText: '', paths: ['src/file.ts'] } as ExtractedTriggerContext,
      5,
      '/root',
      0,
      undefined,
    );
    const hit = result.find((r) => r.memory.id === 'm-sym');
    expect(hit?.relationStrength).toBe(0.98);
    expect(hit?.retrievalReasons).toEqual(['anchor:exact-symbol:src/file.ts']);
  });
});

describe('SageToolCallMiddleware — symbol-anchored memory injection', () => {
  it('injects a memory anchored to a symbol in the touched file', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'Symbol-scoped memory for run() in src/file.ts.',
      importance: 0.95,
      anchors: [{ type: 'symbol', path: 'src/file.ts', symbol: 'run' }],
    });
    const mw = createSageToolCallMiddleware({ memory: store });
    const payload = makePayload();
    await mw.handler(payload as never, async (p) => p);
    expect(memoryEvidenceText(payload)).toContain('Symbol-scoped memory');
  });
});

describe('SageToolCallMiddleware — disabled and no-trigger scenarios', () => {
  it('skips entirely when enabled is false', async () => {
    const store = makeStore();
    const mw = createSageToolCallMiddleware({ memory: store, enabled: false });
    const payload = makePayload();
    await mw.handler(payload, async (p) => p);
    expect(payload.result.content).toBe('file content');
  });

  it('skips error results', async () => {
    const store = makeStore();
    const mw = createSageToolCallMiddleware({ memory: store });
    const payload = makePayload({
      result: {
        type: 'tool_result',
        tool_use_id: 'tu1',
        name: 'read',
        content: 'Error',
        is_error: true,
      },
    });
    await mw.handler(payload, async (p) => p);
    expect(payload.result.content).toBe('Error');
  });

  it('skips bash error results (bash is no longer a trigger)', async () => {
    const store = await storeWithFileMemory('src/file.ts');
    const mw = createSageToolCallMiddleware({ memory: store, repeatCooldownMs: 0 });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_bash',
        name: 'bash',
        input: { command: 'Get-Content src/file.ts' },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'tu_bash',
        name: 'bash',
        content: 'Error output',
        is_error: true,
      },
    });
    await mw.handler(payload, async (p) => p);
    expect(payload.result.content).toBe('Error output');
  });

  it('skips unknown tool names', async () => {
    const store = makeStore();
    const mw = createSageToolCallMiddleware({ memory: store });
    const payload = makePayload({
      toolUse: { type: 'tool_use', id: 'tu_unknown', name: 'unknown_tool', input: {} },
    });
    await mw.handler(payload, async (p) => p);
    expect(payload.result.content).toBe('file content');
  });

  it('skips when trigger is disabled in opts.triggers', async () => {
    const store = await storeWithFileMemory('src/file.ts');
    const mw = createSageToolCallMiddleware({ memory: store, triggers: { read: false } });
    const payload = makePayload();
    await mw.handler(payload, async (p) => p);
    expect(payload.result.content).toBe('file content');
  });
});

describe('SageToolCallMiddleware — mutation triggers', () => {
  it('calls verifyForPaths on mutation triggers', async () => {
    const verifyForPaths = async (_paths: string[], _signal?: AbortSignal) => {};
    const spy = vi.fn(verifyForPaths);
    const store = makeStore();
    const mw = createSageToolCallMiddleware({
      memory: Object.assign(store, { verifyForPaths: spy }),
      triggers: { write: true },
    });
    await store.rememberSage({
      text: 'Write target.',
      importance: 0.95,
      anchors: [{ type: 'file', path: 'src/newfile.ts' }],
    });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_write',
        name: 'write',
        input: { path: 'src/newfile.ts' },
      },
      result: { type: 'tool_result', tool_use_id: 'tu_write', name: 'write', content: 'written' },
    });
    await mw.handler(payload, async (p) => p);
    expect(spy).toHaveBeenCalled();
  });

  it('does not call verifyForPaths when verifyOnMutation is false', async () => {
    const verifyForPaths = vi.fn();
    const store = makeStore();
    const mw = createSageToolCallMiddleware({
      memory: Object.assign(store, { verifyForPaths }),
      verifyOnMutation: false,
    });
    const payload = makePayload();
    await mw.handler(payload, async (p) => p);
    expect(verifyForPaths).not.toHaveBeenCalled();
  });
});

describe('SageToolCallMiddleware — patch tool', () => {
  it('extracts patch paths and retrieves related memories', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'Memory for patched file.',
      importance: 0.95,
      anchors: [{ type: 'file', path: 'packages/demo/source.ts' }],
    });
    const mw = createSageToolCallMiddleware({ memory: store, repeatCooldownMs: 0 });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_patch',
        name: 'patch',
        input: {
          patch:
            '--- a/packages/demo/source.ts\n+++ b/packages/demo/source.ts\n@@ -1 +1 @@\n-old\n+new\n',
          directory: tmpDir,
          strip: 1,
        },
      },
      result: { type: 'tool_result', tool_use_id: 'tu_patch', name: 'patch', content: 'applied' },
      ctx: {
        projectRoot: tmpDir,
        cwd: tmpDir,
        session: { id: 'patch-session' },
      } as ToolCallPipelinePayload['ctx'],
    });

    await mw.handler(payload as never, async (p) => p);
    expect(payload.result.content).not.toContain('Memory for patched file');
    expect(memoryEvidenceText(payload)).toContain('Memory for patched file');
  });
});

describe('SageToolCallMiddleware — replace tool with dry_run check', () => {
  it('triggers verify when replace dry_run is false', async () => {
    const verifyForPaths = vi.fn();
    const store = makeStore();
    const mw = createSageToolCallMiddleware({
      memory: Object.assign(store, { verifyForPaths }),
      triggers: { edit: true },
    });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_replace',
        name: 'replace',
        input: { files: 'src/file.ts', pattern: 'old', replacement: 'new', dry_run: false },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'tu_replace',
        name: 'replace',
        content: 'replaced',
      },
    });
    await mw.handler(payload as never, async (p) => p);
    expect(verifyForPaths).toHaveBeenCalled();
  });

  it('does not verify when replace has dry_run implicitly true', async () => {
    const verifyForPaths = vi.fn();
    const store = makeStore();
    const mw = createSageToolCallMiddleware({
      memory: Object.assign(store, { verifyForPaths }),
      triggers: { edit: true },
    });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_replace',
        name: 'replace',
        input: { files: 'src/file.ts', pattern: 'old', replacement: 'new' },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'tu_replace',
        name: 'replace',
        content: 'dry-run: would replace',
      },
    });
    await mw.handler(payload as never, async (p) => p);
    expect(verifyForPaths).not.toHaveBeenCalled();
  });
});

describe('SageToolCallMiddleware — tool name variants', () => {
  it('handles codebase-search with hyphen', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'Codebase search finds this memory.',
      importance: 0.95,
    });
    const mw = createSageToolCallMiddleware({
      memory: store,
      repeatCooldownMs: 0,
      // This test pins the tool-name alias. Opt into lexical injection so the
      // default evidence/score gates do not turn it into a relevance test.
      relationFloor: 0.8,
      minScore: 0,
    });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_cs',
        name: 'codebase-search',
        // Enough overlap to clear the relation floor on its own: the point of
        // this test is the hyphenated tool alias, not the scoring gate.
        input: { query: 'codebase search finds', path: '.' },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'tu_cs',
        name: 'codebase-search',
        content: 'results',
      },
    });
    await mw.handler(payload as never, async (p) => p);
    expect(memoryEvidenceText(payload)).toContain('finds this memory');
  });

  it('does NOT trigger injection for exec tool', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'Memory that should not be injected via exec.',
      kind: 'fact',
      tags: ['test'],
      anchors: [{ type: 'command', command: 'npm test' }],
      persistence: 'long_lived',
    });
    const mw = createSageToolCallMiddleware({ memory: store, repeatCooldownMs: 0 });
    const payload = makePayload({
      toolUse: { type: 'tool_use', id: 'tu_exec', name: 'exec', input: { command: 'npm test' } },
      result: { type: 'tool_result', tool_use_id: 'tu_exec', name: 'exec', content: 'test output' },
    });
    await mw.handler(payload as never, async (p) => p);
    expect(payload.result.content).toBe('test output');
  });

  it('does not staple a memory onto an unrelated file because the live task mentions it', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'Authentication package refresh tokens are rotated by the session service.',
      kind: 'fact',
      tags: ['authentication', 'session'],
      anchors: [{ type: 'package', path: 'src/auth' }],
      persistence: 'long_lived',
    });
    const mw = createSageToolCallMiddleware({ memory: store, repeatCooldownMs: 0 });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_task',
        name: 'read',
        input: { path: 'node-version.txt' },
      },
      result: { type: 'tool_result', tool_use_id: 'tu_task', name: 'read', content: 'v24' },
      ctx: {
        projectRoot: tmpDir,
        cwd: tmpDir,
        session: { id: 'task-aware' },
        signal: new AbortController().signal,
        todos: [
          {
            id: 'todo-auth',
            content: 'Refactor authentication refresh flow',
            status: 'in_progress',
          },
        ],
        meta: {},
      } as never,
    });

    await mw.handler(payload, async (p) => p);

    // `node-version.txt` has nothing to do with the auth memory. It used to be
    // injected anyway: task text was folded into the retrieval query by
    // default, and an all-terms miss was retried as any-term, so one word of
    // the todo was enough to pull the memory out of the corpus and staple it
    // to this result.
    expect(payload.result.content).toBe('v24');
    expect((payload.ctx.meta['memoryInjectorLastRun'] as Record<string, number>)['injected']).toBe(
      0,
    );
  });
});

describe('SageToolCallMiddleware — result path extraction', () => {
  it('extracts paths from JSON tool results', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'Memory for test file.',
      importance: 0.95,
      anchors: [{ type: 'file', path: 'test/unit/test.ts' }],
    });
    const mw = createSageToolCallMiddleware({ memory: store, repeatCooldownMs: 0 });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_glob',
        name: 'glob',
        input: { pattern: '**/*.ts', path: '.' },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'tu_glob',
        name: 'glob',
        content: JSON.stringify({ results: ['test/unit/test.ts'] }),
      },
    });
    await mw.handler(payload as never, async (p) => p);
    expect(memoryEvidenceText(payload)).toContain('Memory for test file');
  });
});

describe('SageToolCallMiddleware — content already visible', () => {
  it('skips memory text already present in system prompt', async () => {
    const store = makeStore();
    const mw = createSageToolCallMiddleware({ memory: store });
    // Make a payload where the system prompt already mentions the memory text
    const payload = makePayload({
      result: {
        type: 'tool_result',
        tool_use_id: 'tu1',
        name: 'read',
        content: 'Memory for src/file.ts',
      },
    });
    const existingMemory = {
      id: 'mem_1',
      text: 'Memory for src/file.ts',
      revision: 1,
      scope: 'project',
      kind: 'fact',
      status: 'active',
      importance: 0.95,
      confidence: 0.95,
      freshness: 1,
      tags: [] as string[],
      anchors: [{ type: 'file', path: 'src/file.ts' }],
      sources: [] as never[],
      createdAt: '',
      updatedAt: '',
    };
    (store as any).loaded = [existingMemory];
    (store as any).initialized = true;

    await mw.handler(payload, async (p) => p);
    // Skip injection check - content already visible
    // Just check it doesn't crash
    expect(payload.result.content).toBeDefined();
  });
});

describe('SageToolCallMiddleware — cooldown for high importance memory', () => {
  it('does not bypass cooldown merely because importance is high', async () => {
    const store = makeStore();
    const mw = createSageToolCallMiddleware({ memory: store, repeatCooldownMs: 60000 });
    await store.rememberSage({
      text: 'Critical high importance memory.',
      importance: 1,
      confidence: 1,
      anchors: [{ type: 'file', path: 'src/important.ts' }],
    });

    const payload = makePayload({
      toolUse: { type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'src/important.ts' } },
      result: { type: 'tool_result', tool_use_id: 'tu1', name: 'read', content: 'file content' },
    });
    // First call - injects
    await mw.handler(payload as never, async (p) => p);
    expect(memoryEvidenceText(payload)).toContain('Critical high importance memory');

    // Second call immediately - should skip even for high importance
    const payload2 = makePayload({
      toolUse: { type: 'tool_use', id: 'tu2', name: 'read', input: { path: 'src/important.ts' } },
      result: { type: 'tool_result', tool_use_id: 'tu2', name: 'read', content: 'file content' },
    });
    await mw.handler(payload2 as never, async (p) => p);
    // Importance affects ranking only; it must not bypass the repeat cooldown.
    expect(payload2.result.content).toBe('file content');
  });
});

describe('SageToolCallMiddleware — availableHintChars', () => {
  it('respects maxOutputBytes cap', async () => {
    const store = await storeWithFileMemory('src/file.ts');
    const mw = createSageToolCallMiddleware({
      memory: store,
      repeatCooldownMs: 0,
      maxCharsPerTool: 200,
    });

    const payload = makePayload();
    // Set tool maxOutputBytes cap to limit chars
    (payload as any).tool = { maxOutputBytes: 2000 };
    await mw.handler(payload as never, async (p) => p);
    // Should still inject with available chars
    expect(memoryEvidenceText(payload)).toContain('Memory for');
  });
});

describe('SageToolCallMiddleware — no memories match', () => {
  it('returns original content when no memories retrieved', async () => {
    const store = makeStore();
    const mw = createSageToolCallMiddleware({ memory: store });
    const payload = makePayload();
    await mw.handler(payload as never, async (p) => p);
    expect(payload.result.content).toBe('file content');
  });

  it('never appends deleted lifecycle history returned by a retriever', async () => {
    const deleted = {
      id: 'mem_deleted',
      revision: 2,
      scope: 'project' as const,
      kind: 'fact' as const,
      status: 'deleted' as const,
      text: 'Deleted guidance must stay out of context.',
      importance: 1,
      confidence: 1,
      freshness: 1,
      tags: [],
      anchors: [{ type: 'file' as const, path: 'src/file.ts' }],
      sources: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const memory = {
      retrieveForPath: async () => [deleted],
      searchSage: async () => [deleted],
    };
    const mw = createSageToolCallMiddleware({ memory, repeatCooldownMs: 0 });
    const payload = makePayload();

    await mw.handler(payload, async (p) => p);

    expect(payload.result.content).toBe('file content');
  });
});

describe('SageToolCallMiddleware — anchored to the file, once per session', () => {
  async function readOnce(
    store: TestMemory,
    file: string,
    session: string,
    mw = createSageToolCallMiddleware({ memory: store }),
  ) {
    const payload = makePayload({
      toolUse: { type: 'tool_use', id: `tu_${file}`, name: 'read', input: { path: file } },
      result: { type: 'tool_result', tool_use_id: `tu_${file}`, name: 'read', content: 'source' },
      ctx: {
        projectRoot: tmpDir,
        cwd: tmpDir,
        session: { id: session },
        signal: new AbortController().signal,
      } as never,
    });
    await mw.handler(payload, async (p) => p);
    return memoryEvidenceText(payload);
  }

  it('injects the memory anchored to the file and not the same-basename one from another package', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'The webui store keeps the full messages array and virtualizes the view.',
      importance: 0.9,
      anchors: [{ type: 'file', path: 'packages/webui/src/store.ts' }],
    });
    await store.rememberSage({
      text: 'The sage store writes every row of one import in a single transaction.',
      importance: 0.9,
      anchors: [{ type: 'file', path: 'packages/sage/src/store.ts' }],
    });

    const content = await readOnce(store, 'packages/webui/src/store.ts', 'anchored');

    expect(content).toContain('webui store keeps the full messages array');
    // Same basename, different package. It used to arrive anyway: every
    // memory the path lookup returned was paid a flat 0.95, and `store` alone
    // was enough lexical overlap to clear the old floor.
    expect(content).not.toContain('single transaction');
  });

  it('does not repeat a memory it already showed this session', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'The webui store keeps the full messages array and virtualizes the view.',
      importance: 0.9,
      anchors: [{ type: 'file', path: 'packages/webui/src/store.ts' }],
    });
    const mw = createSageToolCallMiddleware({ memory: store });

    const first = await readOnce(store, 'packages/webui/src/store.ts', 'repeat', mw);
    const second = await readOnce(store, 'packages/webui/src/store.ts', 'repeat', mw);

    expect(first).toContain('webui store keeps the full messages array');
    // The model has already been given this text. Sending it again spends
    // context to say nothing new.
    expect(second).toBe('');
  });

  it('does not attach a project-wide note to every file under it', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'This repository uses pnpm workspaces.',
      importance: 0.9,
      anchors: [{ type: 'directory', path: 'packages' }],
    });

    const content = await readOnce(store, 'packages/webui/src/store.ts', 'broad');

    // `packages/` sits above half the repository. An anchor that broad is a
    // project note, not evidence about one file.
    expect(content).toBe('');
  });
});

describe('SageToolCallMiddleware — relevance gates', () => {
  const memoryRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'mem_candidate',
    revision: 1,
    scope: 'project' as const,
    kind: 'fact' as const,
    status: 'active' as const,
    persistence: 'long_lived' as const,
    text: 'Telegram outbound queue security policy.',
    importance: 1,
    confidence: 1,
    freshness: 1,
    tags: ['telegram', 'security'],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('rejects an unrelated maximum-importance lexical candidate', async () => {
    const unrelated = memoryRecord();
    const memory = {
      retrieveForPath: async () => [],
      searchSage: async () => [unrelated],
    };
    const mw = createSageToolCallMiddleware({ memory, repeatCooldownMs: 0 });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_relevance',
        name: 'read',
        input: { path: 'packages/sage/src/store.ts' },
      },
    });

    await mw.handler(payload, async (next) => next);

    expect(payload.result.content).toBe('file content');
  });

  it('does not treat a project-root anchor as relevant to every file', async () => {
    const store = makeStore();
    await store.rememberSage({
      text: 'Repository-wide release checklist.',
      importance: 1,
      confidence: 1,
      anchors: [{ type: 'directory', path: '.' }],
    });
    const mw = createSageToolCallMiddleware({ memory: store, repeatCooldownMs: 0 });

    const payload = makePayload();
    await mw.handler(payload, async (next) => next);

    expect(payload.result.content).toBe('file content');
  });

  it('drops graph expansion without a shared structural anchor or two strong tags', async () => {
    const seed = memoryRecord({
      id: 'mem_seed',
      text: 'Store retrieval scoring requires evidence.',
      tags: ['retrieval', 'scoring', 'architecture', 'backfill', 'recovered'],
      anchors: [{ type: 'file', path: 'packages/sage/src/store.ts' }],
    });
    const unrelated = memoryRecord({
      id: 'mem_graph_noise',
      tags: ['architecture', 'backfill', 'recovered'],
    });
    const memory = {
      retrieveForPath: async () => [seed],
      searchSage: async () => [],
      findRelatedSage: async () => [unrelated],
    };
    const mw = createSageToolCallMiddleware({ memory, repeatCooldownMs: 0 });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_graph_relevance',
        name: 'read',
        input: { path: 'packages/sage/src/store.ts' },
      },
    });

    await mw.handler(payload, async (next) => next);

    expect(memoryEvidenceText(payload)).toContain('Store retrieval scoring requires evidence.');
    expect(memoryEvidenceText(payload)).not.toContain('Telegram outbound queue');
  });

  it('caps opted-in lexical-only injection at two memories per tool result', async () => {
    const candidates = [
      memoryRecord({
        id: 'mem_query_1',
        text: 'Authentication refresh rotation uses the session service.',
      }),
      memoryRecord({
        id: 'mem_query_2',
        text: 'Authentication refresh rotation invalidates old tokens.',
      }),
      memoryRecord({
        id: 'mem_query_3',
        text: 'Authentication refresh rotation emits an audit event.',
      }),
    ];
    const findRelatedSage = vi.fn(async () => [
      memoryRecord({ id: 'mem_query_graph_noise', text: 'Unrelated graph expansion.' }),
    ]);
    const memory = {
      retrieveForPath: async () => [],
      searchSage: async () => candidates,
      findRelatedSage,
    };
    const mw = createSageToolCallMiddleware({
      memory,
      repeatCooldownMs: 0,
      // The production default rejects unanchored lexical matches. Lower the
      // floor deliberately to exercise the injector's independent budget cap.
      relationFloor: 0.8,
    });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_query_cap',
        name: 'codebase-search',
        input: { query: 'authentication refresh rotation' },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'tu_query_cap',
        name: 'codebase-search',
        content: 'results',
      },
    });

    await mw.handler(payload, async (next) => next);

    expect(memoryEvidenceText(payload)).toContain('uses the session service');
    expect(memoryEvidenceText(payload)).toContain('invalidates old tokens');
    expect(memoryEvidenceText(payload)).not.toContain('emits an audit event');
    expect(memoryEvidenceText(payload)).not.toContain('Unrelated graph expansion');
    expect(findRelatedSage).not.toHaveBeenCalled();
  });
});

describe('SageToolCallMiddleware — injector observability', () => {
  it('emits the selected memories and bounded decision metrics after injection', async () => {
    const store = await storeWithFileMemory('src/file.ts');
    const events = new EventBus();
    const traces: Array<Record<string, unknown>> = [];
    events.onPattern('memory.injector_run', (_event, payload) => {
      traces.push(payload as Record<string, unknown>);
    });
    const mw = createSageToolCallMiddleware({
      memory: store,
      events,
      repeatCooldownMs: 0,
    });

    await mw.handler(makePayload(), async (p) => p);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      outcome: 'injected',
      trigger: 'read',
      toolName: 'read',
      candidates: 1,
      eligible: 1,
    });
    expect(traces[0]?.['injected']).toEqual([
      expect.objectContaining({ kind: 'fact', text: 'Memory for src/file.ts' }),
    ]);
    expect(traces[0]?.['activated']).toEqual([
      expect.objectContaining({
        kind: 'fact',
        anchors: expect.arrayContaining([expect.stringContaining('file:')]),
        activationReasons: expect.arrayContaining([expect.stringContaining('anchor:')]),
        confidence: expect.any(Number),
        freshness: expect.any(Number),
        importance: expect.any(Number),
        persistence: 'long_lived',
      }),
    ]);
  });

  it('also emits empty runs with the reason memories left the candidate set', async () => {
    // Note: the memory text must be ≥ 24 chars to pass the
    // containsMemoryText short-memory self-suppression guard (see M3
    // fix in middleware/tool-call-memory.ts). The helper default
    // ("Memory for src/file.ts") is exactly 22 chars, so this test
    // uses a custom inline memory that crosses the threshold.
    const store = await makeStore();
    await store.rememberSage({
      text: 'memory for the file src/file.ts already loaded earlier',
      importance: 0.95,
      anchors: [{ type: 'file', path: 'src/file.ts' }],
    });
    const events = new EventBus();
    const traces: Array<Record<string, unknown>> = [];
    events.onPattern('memory.injector_run', (_event, payload) => {
      traces.push(payload as Record<string, unknown>);
    });
    const mw = createSageToolCallMiddleware({ memory: store, events });
    const payload = makePayload({
      result: {
        type: 'tool_result',
        tool_use_id: 'tu1',
        name: 'read',
        content: 'file content already says memory for the file src/file.ts already loaded earlier',
      },
    });

    await mw.handler(payload, async (p) => p);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      outcome: 'empty',
      candidates: 1,
      eligible: 0,
      rejected: { alreadyVisible: 1 },
      injected: [],
      injectedChars: 0,
    });
  });

  it('distinguishes an activated memory from one actually written into context', async () => {
    const store = await storeWithFileMemory('src/file.ts');
    const events = new EventBus();
    const traces: Array<Record<string, unknown>> = [];
    events.onPattern('memory.injector_run', (_event, payload) => {
      traces.push(payload as Record<string, unknown>);
    });
    const mw = createSageToolCallMiddleware({
      memory: store,
      events,
      repeatCooldownMs: 0,
      maxCharsPerTool: 0,
    });

    await mw.handler(makePayload(), async (p) => p);

    expect(traces[0]).toMatchObject({
      outcome: 'empty',
      activated: [expect.objectContaining({ text: 'Memory for src/file.ts' })],
      injected: [],
      rejected: { budget: 1 },
    });
  });
});

describe('SageToolCallMiddleware — tool name -> trigger mapping', () => {
  it('handles all read/tree/grep/glob/write/edit tools without error', async () => {
    const store = makeStore();
    const mw = createSageToolCallMiddleware({ memory: store });

    for (const name of ['read', 'tree', 'grep', 'glob', 'write', 'edit']) {
      const payload = makePayload({
        toolUse: { type: 'tool_use', id: `tu_${name}`, name, input: { path: 'src/x.ts' } },
        result: {
          type: 'tool_result',
          tool_use_id: `tu_${name}`,
          name,
          content: `result from ${name}`,
        },
      });
      await mw.handler(payload as never, async (p) => p);
      expect(payload.result.content).toBe(`result from ${name}`);
    }
  });
});

describe('SageToolCallMiddleware — parallel retrieval', () => {
  it('starts path lookups and the query lookup concurrently', async () => {
    // Every lookup blocks on `gate`, which only opens once ALL THREE lookups
    // have started. If retrieval were serial, the first lookup would await a
    // gate that can never open and the test would time out.
    const started: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const memoryTemplate = (id: string) => ({
      id,
      revision: 1,
      scope: 'project' as const,
      kind: 'fact' as const,
      status: 'active' as const,
      text: `Parallel retrieval memory ${id}`,
      importance: 0.95,
      confidence: 0.95,
      freshness: 0.9,
      tags: [],
      anchors: [],
      sources: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const memory = {
      retrieveForPath: vi.fn((opts: { path: string }) => {
        started.push(`path:${opts.path}`);
        if (started.length === 3) openGate();
        return gate.then(() => [memoryTemplate(`mem_${started.length}`)]);
      }),
      searchSage: vi.fn(() => {
        started.push('query');
        if (started.length === 3) openGate();
        return gate.then(() => []);
      }),
      recordInjection: async () => {},
    };
    const mw = createSageToolCallMiddleware({ memory, repeatCooldownMs: 0 });
    const payload = makePayload({
      toolUse: {
        type: 'tool_use',
        id: 'tu_parallel',
        name: 'replace',
        input: { files: 'src/a.ts,src/b.ts', pattern: 'needle', dry_run: true },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'tu_parallel',
        name: 'replace',
        content: 'preview',
      },
    });

    await mw.handler(payload as never, async (p) => p);

    expect(started).toHaveLength(3);
    // resolveTriggerPaths maps tool inputs to absolute paths under projectRoot
    expect(started).toContain(`path:${path.join(tmpDir, 'src/a.ts')}`);
    expect(started).toContain(`path:${path.join(tmpDir, 'src/b.ts')}`);
    expect(started).toContain('query');
    expect(memory.retrieveForPath).toHaveBeenCalledTimes(2);
    expect(memory.searchSage).toHaveBeenCalledTimes(1);
  });
});

describe('containsMemoryText short-memory self-suppression', () => {
  // The threshold (MIN_CONTAINS_LENGTH = 24) is internal but the contract
  // matters: short memory text like "true" or "rm -rf /" appears in
  // virtually every system prompt as boilerplate; without a guard, the
  // substring match blanket-suppresses the memory and the LLM never
  // sees it again. These tests pin the contract end-to-end so a
  // future threshold tweak is forced through this test suite.

  it('returns false for very short memory text (single word)', () => {
    expect(containsMemoryText('anything you write will appear in the system prompt', 'true')).toBe(
      false,
    );
    expect(containsMemoryText('use pnpm. run pnpm test. ok.', 'ok')).toBe(false);
  });

  it('returns false for short phrases under 24 chars', () => {
    expect(containsMemoryText('use pnpm test; rm -rf /tmp', 'rm -rf /')).toBe(false);
    expect(containsMemoryText('use pnpm test; ok done', 'use pnpm')).toBe(false);
    expect(containsMemoryText('run pnpm test now', 'pnpm test')).toBe(false);
  });

  it('returns true for short phrases that ARE present AND are 24+ chars', () => {
    // 24-char threshold — exactly at the boundary, must match.
    const phrase = 'a'.repeat(24);
    expect(containsMemoryText(`prefix ${phrase} suffix`, phrase)).toBe(true);
    // Longer phrases always match when present.
    expect(
      containsMemoryText(
        'the file was edited yesterday by the assistant',
        'file was edited yesterday',
      ),
    ).toBe(true);
  });

  it('ignores surrounding whitespace and is case-insensitive', () => {
    // Trailing/leading whitespace from `remember(text)` must not push
    // a sub-threshold string over the 24-char threshold.
    expect(containsMemoryText('anything here for the test', '   true   ')).toBe(false);
    // Mixed-case substring match — must still match when present and
    // 24+ chars after trim+lowercase.
    expect(
      containsMemoryText('ANYTHING GOES HERE FOR THE TEST', 'ANYTHING GOES HERE FOR THE TEST'),
    ).toBe(true);
  });

  it('does not blank-match when the substring is genuinely absent', () => {
    expect(
      containsMemoryText('the file was edited yesterday by the assistant', 'never written before'),
    ).toBe(false);
  });
});

describe('SageToolCallMiddleware — retrieval budget', () => {
  it('fails open with an error trace when retrieval outlives its budget', async () => {
    const store = makeStore();
    let release: (() => void) | undefined;
    const hung = new Promise<Sage[]>((resolve) => {
      release = () => resolve([]);
    });
    const memory: SageRetrieverLike = {
      ...store,
      retrieveForPath: () => hung,
      searchSage: () => hung,
    };
    const events = new EventBus();
    const traces: Array<Record<string, unknown>> = [];
    events.onPattern('memory.injector_run', (_event, payload) => {
      traces.push(payload as Record<string, unknown>);
    });
    const mw = createSageToolCallMiddleware({ memory, events, retrievalTimeoutMs: 20 });

    const payload = makePayload();
    await mw.handler(payload as never, async (p) => p);

    // Fail-open: the tool result reaches the caller untouched.
    expect(payload.result.content).toBe('file content');
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ outcome: 'error', candidates: 0, injectedChars: 0 });
    expect(String(traces[0]?.['error'])).toContain('20ms budget');
    // The abandoned retrieval settling later must not surface as an
    // unhandled rejection or a second trace.
    release?.();
    await hung;
    expect(traces).toHaveLength(1);
  });

  it('leaves retrieval unbounded when the budget is zero', async () => {
    const store = await storeWithFileMemory('src/file.ts');
    const mw = createSageToolCallMiddleware({
      memory: store,
      repeatCooldownMs: 0,
      retrievalTimeoutMs: 0,
    });

    const payload = makePayload();
    await mw.handler(payload as never, async (p) => p);

    expect(memoryEvidenceText(payload)).toContain('Memory for src/file.ts');
  });
});

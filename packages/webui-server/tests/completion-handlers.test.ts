import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { Provider } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const searchCodebaseIndex = vi.fn();

vi.mock('@wrongstack/tools/codebase-index/index', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    searchCodebaseIndex,
  };
});

// The in-test `await import(...)` of completion-handlers pays the whole module
// graph's transform cost on first hit — under full-suite CPU contention that
// alone can blow the default 5s budget, so give the block generous headroom.
describe('completion WebSocket handler', { timeout: 30_000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(process.env.TEMP || '/tmp', `completion-${randomBytes(4).toString('hex')}`);
    fsSync.mkdirSync(tempDir, { recursive: true });
    searchCodebaseIndex.mockReset();
    searchCodebaseIndex.mockResolvedValue({
      total: 1,
      results: [
        {
          id: 1,
          name: 'findByEmailAndStatus',
          kind: 'method',
          lang: 'ts',
          file: path.join(tempDir, 'src', 'user-repository.ts'),
          line: 12,
          col: 2,
          signature: 'findByEmailAndStatus(email: string, status: UserStatus): Promise<User>',
          docComment: 'Find a user by email and status.',
          score: 42,
          snippet: 'findByEmailAndStatus',
        },
      ],
    });
  });

  afterEach(() => {
    fsSync.rmSync(tempDir, { recursive: true, force: true });
  });

  it('combines LLM suggestions with codebase index suggestions', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const complete = vi.fn(async (req: unknown) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            items: [
              {
                label: 'findByEmailAndStatus',
                insertText: 'findByEmailAndStatus(email, status)',
                kind: 'method',
                detail: 'repository query',
              },
            ],
          }),
        },
      ],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'test-model',
      request: req,
    }));
    const provider = {
      id: 'mock',
      capabilities: { structuredOutput: false, jsonMode: true },
      complete,
    } as never as Provider;
    const ws = createMockWs();

    await handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r1',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 10,
          column: 14,
          prefix: 'class UserRepository {\n  async findBy',
          suffix: '\n}',
        },
      },
      { projectRoot: tempDir, provider, model: 'test-model' },
    );

    expect(complete).toHaveBeenCalledOnce();
    expect(searchCodebaseIndex).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: path.resolve(tempDir), query: 'findBy', limit: 8 }),
      expect.objectContaining({ timeoutMs: 1500 }),
    );
    expect(JSON.stringify(complete.mock.calls[0]?.[0])).toContain('findByEmailAndStatus');
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'completion.result',
      payload: {
        requestId: 'r1',
        filePath: 'src/user-repository.ts',
        items: [
          {
            label: 'findByEmailAndStatus',
            insertText: 'findByEmailAndStatus(email, status)',
            kind: 'method',
            source: 'llm',
          },
          {
            label: 'findByEmailAndStatus',
            insertText: 'findByEmailAndStatus',
            kind: 'method',
            source: 'index',
          },
        ],
      },
    });
  });

  it('returns index suggestions without a provider', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const ws = createMockWs();

    await handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r2',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 1,
          column: 3,
          prefix: 'fi',
        },
      },
      { projectRoot: tempDir },
    );

    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'completion.result',
      payload: {
        requestId: 'r2',
        items: [{ label: 'findByEmailAndStatus', source: 'index' }],
      },
    });
  });

  it('skips the LLM provider when allowLlm is false', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const complete = vi.fn();
    const provider = {
      id: 'mock',
      capabilities: { structuredOutput: false, jsonMode: true },
      complete,
    } as never as Provider;
    const ws = createMockWs();

    await handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r-no-llm',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 1,
          column: 3,
          prefix: 'fi',
          allowLlm: false,
        },
      },
      { projectRoot: tempDir, provider, model: 'test-model' },
    );

    expect(complete).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'completion.result',
      payload: {
        requestId: 'r-no-llm',
        items: [{ source: 'index' }],
      },
    });
  });

  it('puts optional LSP suggestions before fallback suggestions', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const lspCompletion = vi.fn(async () => [
      {
        label: 'findByEmail',
        insertText: 'findByEmail',
        kind: 'method' as const,
        detail: 'LSP precise match',
        source: 'lsp' as const,
      },
    ]);
    const ws = createMockWs();

    await handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r-lsp',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 4,
          column: 12,
          content: 'const unsaved = repo.findBy',
          prefix: 'repo.findBy',
          triggerCharacter: '.',
        },
      },
      { projectRoot: tempDir, lspCompletion },
    );

    expect(lspCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: path.resolve(tempDir, 'src/user-repository.ts'),
        lineNumber: 4,
        column: 12,
        content: 'const unsaved = repo.findBy',
        triggerCharacter: '.',
      }),
    );
    expect(ws.sent).toHaveLength(1);
    const response = ws.sent[0] as {
      payload: { items: Array<{ label: string; source: string }> };
    };
    expect(response.payload.items[0]).toMatchObject({
      label: 'findByEmail',
      source: 'lsp',
    });
    expect(response.payload.items.some((item) => item.source === 'index')).toBe(true);
  });

  it('uses machine-readable LSP tool output when wrapping the tool source', async () => {
    const { createToolLspCompletionSource } = await import('@wrongstack/webui-server');
    const execute = vi.fn(async () =>
      JSON.stringify({
        items: [
          {
            label: 'findByEmail',
            insertText: 'findByEmail(email)',
            kind: 'Method',
            detail: 'semantic match',
          },
        ],
      }),
    );
    const source = createToolLspCompletionSource({ execute } as never, { cwd: tempDir } as never);

    const items = await source!({
      filePath: path.resolve(tempDir, 'src/user-repository.ts'),
      lineNumber: 3,
      column: 12,
      content: 'repo.findBy',
      triggerCharacter: '.',
      signal: new AbortController().signal,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: path.resolve(tempDir, 'src/user-repository.ts'),
        line: 3,
        character: 12,
        content: 'repo.findBy',
        trigger_character: '.',
        format: 'json',
      }),
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(items).toEqual([
      {
        label: 'findByEmail',
        insertText: 'findByEmail(email)',
        kind: 'method',
        detail: 'semantic match',
        documentation: undefined,
        sortText: 'a-000-findByEmail',
        source: 'lsp',
      },
    ]);
  });

  it('rejects invalid cursor positions before provider work', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const complete = vi.fn();
    const lspCompletion = vi.fn();
    const provider = {
      id: 'mock',
      capabilities: { structuredOutput: false, jsonMode: false },
      complete,
    } as never as Provider;
    const ws = createMockWs();

    await handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r-bad-cursor',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 0,
          column: 1.5,
          prefix: 'find',
        },
      },
      { projectRoot: tempDir, provider, model: 'test-model', lspCompletion },
    );

    expect(complete).not.toHaveBeenCalled();
    expect(lspCompletion).not.toHaveBeenCalled();
    expect(searchCodebaseIndex).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([
      {
        type: 'completion.result',
        payload: {
          requestId: 'r-bad-cursor',
          filePath: 'src/user-repository.ts',
          items: [],
          error: 'Invalid cursor position',
        },
      },
    ]);
  });

  it('rejects paths outside the project root', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const provider = {
      id: 'mock',
      capabilities: { structuredOutput: false, jsonMode: false },
      complete: vi.fn(),
    } as never as Provider;
    const ws = createMockWs();

    await handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r3',
          filePath: '../outside.ts',
          language: 'typescript',
          lineNumber: 1,
          column: 1,
          prefix: 'x',
        },
      },
      { projectRoot: tempDir, provider, model: 'test-model' },
    );

    expect(provider.complete).not.toHaveBeenCalled();
    expect(searchCodebaseIndex).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([
      {
        type: 'completion.result',
        payload: {
          requestId: 'r3',
          filePath: '../outside.ts',
          items: [],
          error: 'Forbidden',
        },
      },
    ]);
  });
});

function createMockWs() {
  return {
    readyState: 1,
    sent: [] as unknown[],
    send(data: string) {
      this.sent.push(JSON.parse(data));
    },
  } as never as WebSocket & { sent: unknown[] };
}

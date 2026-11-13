import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { Provider } from '@wrongstack/contracts/types';
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

  it('rejects in-project symlinks pointing outside the project root and accepts case-variant Windows paths (F845)', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const outsideDir = path.join(
      process.env.TEMP || '/tmp',
      `completion-outside-${randomBytes(4).toString('hex')}`,
    );
    fsSync.mkdirSync(outsideDir, { recursive: true });
    try {
      const secretFile = path.join(outsideDir, 'secret.ts');
      fsSync.writeFileSync(secretFile, 'export const secret = 1;\n', 'utf8');
      const symlinkPath = path.join(tempDir, 'escape-link.ts');
      fsSync.symlinkSync(secretFile, symlinkPath, 'file');

      const lspCompletion = vi.fn(async () => []);
      const ws = createMockWs();
      await handleCompletionRequest(
        ws,
        {
          type: 'completion.request',
          payload: {
            requestId: 'r-symlink',
            filePath: 'escape-link.ts',
            language: 'typescript',
            lineNumber: 1,
            column: 1,
            prefix: 'secret',
          },
        },
        { projectRoot: tempDir, lspCompletion },
      );

      expect(lspCompletion).not.toHaveBeenCalled();
      expect(ws.sent).toEqual([
        {
          type: 'completion.result',
          payload: {
            requestId: 'r-symlink',
            filePath: 'escape-link.ts',
            items: [],
            error: 'Forbidden',
          },
        },
      ]);

      if (process.platform === 'win32') {
        const insideFile = path.join(tempDir, 'inside.ts');
        fsSync.writeFileSync(insideFile, 'const x = 1;\n', 'utf8');
        const toggledRoot =
          tempDir[0] === tempDir[0]!.toUpperCase()
            ? tempDir[0]!.toLowerCase() + tempDir.slice(1)
            : tempDir[0]!.toUpperCase() + tempDir.slice(1);
        const wsWin = createMockWs();
        await handleCompletionRequest(
          wsWin,
          {
            type: 'completion.request',
            payload: {
              requestId: 'r-win-case',
              filePath: path.join(toggledRoot, 'inside.ts'),
              language: 'typescript',
              lineNumber: 1,
              column: 1,
              prefix: 'const',
            },
          },
          { projectRoot: tempDir, lspCompletion },
        );
        expect((wsWin.sent[0] as { payload: { error?: string } }).payload.error).toBeUndefined();
      }
    } finally {
      fsSync.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('never splits a surrogate pair when the prefix/suffix cap cut lands inside one', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const complete = vi.fn(async (_req: unknown) => ({
      content: [{ type: 'text', text: '{"items":[]}' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'test-model',
    }));
    const provider = {
      id: 'mock',
      capabilities: { structuredOutput: false, jsonMode: true },
      complete,
    } as never as Provider;
    const ws = createMockWs();
    const emoji = '😀'; // U+1F600 = D83D DE00

    await handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r-surrogate-cut',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 1,
          column: 1,
          prefix: `x${emoji}${'y'.repeat(11_999)}`, // 12_002 units → tail cut splits the pair
          suffix: `${'z'.repeat(3_999)}${emoji}w`, // 4_002 units → head cut splits the pair
          allowLlm: true,
        },
      },
      { projectRoot: tempDir, provider, model: 'test-model' },
    );

    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0]?.[0] as
      | { messages: Array<{ content: string }> }
      | undefined;
    const prompt = request?.messages[0]?.content ?? '';
    expect(prompt.length).toBeGreaterThan(0);
    // No ill-formed lone surrogate may reach the model request (checked on the
    // raw content string — JSON.stringify would escape the surrogate away).
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(prompt),
      'completion prompt carries a lone surrogate after cap truncation',
    ).toBe(false);
  });

  it('keeps a pair-aligned prefix cap cut lossless', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const complete = vi.fn(async (_req: unknown) => ({
      content: [{ type: 'text', text: '{"items":[]}' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'test-model',
    }));
    const provider = {
      id: 'mock',
      capabilities: { structuredOutput: false, jsonMode: true },
      complete,
    } as never as Provider;
    const ws = createMockWs();
    const emoji = '😀';

    await handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r-surrogate-aligned',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 1,
          column: 1,
          prefix: emoji.repeat(6_001), // 12_002 units → cut at 2, a pair boundary
          suffix: 'const x = 1;',
          allowLlm: true,
        },
      },
      { projectRoot: tempDir, provider, model: 'test-model' },
    );

    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0]?.[0] as
      | { messages: Array<{ content: string }> }
      | undefined;
    const prompt = request?.messages[0]?.content ?? '';
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(prompt),
      'aligned cut produced a lone surrogate',
    ).toBe(false);
    // The prompt embeds the capped prefix twice (`Current line prefix` and
    // <prefix>): 6_000 emojis per embedding must survive the aligned cut.
    expect((prompt.match(/\u{1F600}/gu) ?? []).length).toBe(12_000);
  });

  it('leaves prefix/suffix fields below the caps verbatim', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const complete = vi.fn(async (_req: unknown) => ({
      content: [{ type: 'text', text: '{"items":[]}' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'test-model',
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
          requestId: 'r-surrogate-short',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 1,
          column: 1,
          prefix: 'hello 😀 world',
          suffix: 'const x = 1;',
          allowLlm: true,
        },
      },
      { projectRoot: tempDir, provider, model: 'test-model' },
    );

    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0]?.[0] as
      | { messages: Array<{ content: string }> }
      | undefined;
    const prompt = request?.messages[0]?.content ?? '';
    expect(prompt.includes('hello 😀 world')).toBe(true);
    expect(prompt.includes('const x = 1;')).toBe(true);
  });

  it('aborts superseded in-flight requests on the same socket before calling the LLM provider', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    let r1Entered!: () => void;
    const r1EnteredPromise = new Promise<void>((r) => {
      r1Entered = r;
    });
    let releaseR1!: () => void;
    const r1Gate = new Promise<void>((r) => {
      releaseR1 = r;
    });
    let r1Signal: AbortSignal | undefined;
    const complete = vi.fn(async () => ({
      content: [{ type: 'text', text: '{"items":[{"label":"stale","insertText":"stale"}]}' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'test-model',
    }));
    const provider = {
      id: 'mock',
      capabilities: { structuredOutput: false, jsonMode: false },
      complete,
    } as never as Provider;
    const ws = createMockWs();

    const p1 = handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r1',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 1,
          column: 7,
          prefix: 'findBy',
          allowLlm: true,
        },
      },
      {
        projectRoot: tempDir,
        provider,
        model: 'test-model',
        lspCompletion: async ({ signal }) => {
          r1Signal = signal;
          r1Entered();
          await r1Gate;
          return [];
        },
      },
    );

    await r1EnteredPromise;

    await handleCompletionRequest(
      ws,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r2',
          filePath: 'src/user-repository.ts',
          language: 'typescript',
          lineNumber: 1,
          column: 8,
          prefix: 'findByE',
          allowLlm: false,
        },
      },
      {
        projectRoot: tempDir,
        provider,
        model: 'test-model',
        lspCompletion: async () => [
          { label: 'findByEmail', insertText: 'findByEmail', source: 'lsp' },
        ],
      },
    );

    expect(r1Signal?.aborted).toBe(true);
    releaseR1();
    await p1;

    expect(complete).not.toHaveBeenCalled();
    expect(
      (ws.sent as Array<{ payload: { requestId: string } }>).map((f) => f.payload.requestId),
    ).toEqual(['r2']);
  });

  it('does not trigger LLM completions from filename stems on blank prefixes and parses JSON with trailing notes', async () => {
    const { handleCompletionRequest } = await import('@wrongstack/webui-server');
    const complete = vi.fn(async () => ({
      content: [
        {
          type: 'text',
          text: '{"items":[{"label":"useAuthState","insertText":"() => { return \\"{\\"; }","kind":"function"}]}\nNote: see {docs} above.',
        },
      ],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'test-model',
    }));
    const provider = {
      id: 'mock',
      capabilities: { structuredOutput: false, jsonMode: false },
      complete,
    } as never as Provider;

    const wsBlank = createMockWs();
    await handleCompletionRequest(
      wsBlank,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r-blank-hook-file',
          filePath: 'src/useAuth.ts',
          language: 'typescript',
          lineNumber: 2,
          column: 3,
          prefix: 'export const x = 1;\n  ',
        },
      },
      { projectRoot: tempDir, provider, model: 'test-model' },
    );
    expect(complete).not.toHaveBeenCalled();

    const wsTrailing = createMockWs();
    await handleCompletionRequest(
      wsTrailing,
      {
        type: 'completion.request',
        payload: {
          requestId: 'r-trailing-json',
          filePath: 'src/useAuth.ts',
          language: 'typescript',
          lineNumber: 2,
          column: 8,
          prefix: 'useAuth',
        },
      },
      { projectRoot: tempDir, provider, model: 'test-model' },
    );
    expect(complete).toHaveBeenCalledOnce();
    expect(wsTrailing.sent[0]).toMatchObject({
      type: 'completion.result',
      payload: {
        requestId: 'r-trailing-json',
        items: expect.arrayContaining([
          expect.objectContaining({
            label: 'useAuthState',
            insertText: '() => { return "{"; }',
            source: 'llm',
          }),
        ]),
      },
    });
  });
});

function createMockWs() {
  const sent: unknown[] = [];
  return {
    readyState: 1,
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  } as never as WebSocket & { sent: unknown[] };
}

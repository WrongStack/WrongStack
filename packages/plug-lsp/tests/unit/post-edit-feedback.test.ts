import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { HookInput, Logger } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { mergeConfig } from '../../src/config.js';
import { DocumentTracker } from '../../src/document-tracker.js';
import { createPostEditFeedback } from '../../src/post-edit-feedback.js';
import { LSPServer } from '../../src/server/lsp-server.js';
import type { ToolDeps } from '../../src/tools/shared.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const error: Diagnostic = {
  range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
  severity: 1,
  source: 'typescript',
  code: 2322,
  message: 'Type string is not assignable to number',
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-feedback-'));
  roots.push(root);
  const file = path.join(root, 'a.ts');
  await fs.writeFile(file, 'const a: number = "x";');
  const log = { debug() {}, warn() {} } as unknown as Logger;
  const server = new LSPServer(
    'typescript',
    { command: 'unused', languages: ['typescript'] },
    {
      cwd: root,
      rootPath: root,
      log,
      events: new EventBus(),
    },
  );
  server.state = 'ready';
  server.capabilities = {
    diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
  };
  const pull = vi.spyOn(server, 'pullDiagnostics').mockResolvedValue([error]);
  const registry = {
    list: () => [server],
    get: () => server,
    findForPath: async () => server,
    languageIdForPath: (target: string) => (target.endsWith('.ts') ? 'typescript' : null),
  };
  const tracker = new DocumentTracker(() => registry, log, root);
  const cfg = mergeConfig({ diagnosticsWaitMs: 15 });
  let current = true;
  const hook = createPostEditFeedback(
    { registry, tracker, cfg, log } as unknown as ToolDeps,
    () => () => current,
  );
  const input: HookInput = {
    event: 'PostToolUse',
    toolName: 'edit',
    toolInput: { path: file },
    toolResult: { content: 'edited', isError: false },
    cwd: root,
    sessionId: 'owned',
  };
  const run = (value = input, signal = new AbortController().signal) =>
    hook(value, { signal, deadlineAt: Date.now() + 1000 });
  return {
    root,
    file,
    server,
    pull,
    registry,
    tracker,
    cfg,
    input,
    run,
    leave: () => {
      current = false;
    },
  };
}

describe('same-call post-edit LSP feedback', () => {
  it('does not begin analysis after the originating session leaves', async () => {
    const f = await fixture();
    f.leave();
    expect(await f.run()).toBeUndefined();
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('does not invent a target when single-file metadata is absent', async () => {
    const f = await fixture();
    expect(await f.run({ ...f.input, toolInput: {} })).toBeUndefined();
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('ignores a replace preview with no modified-file metadata', async () => {
    const f = await fixture();
    expect(
      await f.run({ ...f.input, toolName: 'replace', toolInput: { files: '*.ts' } }),
    ).toBeUndefined();
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('does not offer bulk feedback without a configured language server', async () => {
    const f = await fixture();
    f.registry.list = () => [];
    expect(await f.run({ ...f.input, toolName: 'patch', toolInput: {} })).toBeUndefined();
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('reports omitted bulk scope even with an empty returned file list', async () => {
    const f = await fixture();
    const output = await f.run({
      ...f.input,
      toolName: 'patch',
      toolInput: {},
      toolResult: {
        content: 'patched',
        isError: false,
        modifiedPaths: [],
        modifiedPathsOmitted: 2,
      },
    });
    expect(output?.additionalContext).toContain('2 additional file scope entries not checked');
    expect(output?.additionalContext).toContain('Verified file(s): 0');
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('stops analysis if the session leaves while resolving its server', async () => {
    const f = await fixture();
    f.registry.findForPath = async () => {
      f.leave();
      return f.server;
    };
    expect(await f.run()).toBeUndefined();
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('marks a file removed before document tracking as unverified', async () => {
    const f = await fixture();
    await fs.unlink(f.file);
    const output = await f.run();
    expect(output?.additionalContext).toContain('file not verified');
    expect(output?.additionalContext).not.toContain('No LSP diagnostics');
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('marks a document lost immediately after opening as unverified', async () => {
    const f = await fixture();
    vi.spyOn(f.tracker, 'get').mockReturnValue(null);
    const output = await f.run();
    expect(output?.additionalContext).toContain('file not verified');
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('bounds the server identity in feedback without dropping file verification', async () => {
    const f = await fixture();
    f.cfg.diagnosticsWaitMs = 1000;
    Object.defineProperty(f.server, 'name', { value: 'typescript'.repeat(30) });
    const output = await f.run();
    expect(output?.additionalContext).toContain('…".');
    expect(output?.additionalContext).not.toContain(f.server.name);
    expect(output?.additionalContext).toContain('Verified file(s): 1');
  });

  it('checks deduplicated bulk-write paths even when result text is spooled', async () => {
    const f = await fixture();
    f.cfg.diagnosticsWaitMs = 1000;
    const second = path.join(f.root, 'b.ts');
    await fs.writeFile(second, 'const b: number = "x";');
    const output = await f.run({
      ...f.input,
      toolName: 'replace',
      toolInput: { files: '*.ts', dry_run: false },
      toolResult: {
        content: '[spooled output]',
        isError: false,
        modifiedPaths: [f.file, second, f.file],
      },
    });
    expect(output?.additionalContext).toContain('a.ts');
    expect(output?.additionalContext).toContain('b.ts');
    expect(output?.additionalContext).toContain('Verified file(s): 2');
    expect(f.pull).toHaveBeenCalledTimes(2);
  });

  it('keeps the total diagnostic count and text budget across bulk files', async () => {
    const f = await fixture();
    const files = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const file = path.join(f.root, `bulk-${i}.ts`);
        await fs.writeFile(file, 'const a = 1;');
        return file;
      }),
    );
    f.cfg.diagnosticsWaitMs = 1000;
    f.cfg.maxDiagnosticsTotal = 3;
    f.pull.mockResolvedValue([{ ...error, message: 'x'.repeat(20_000) }]);
    const input = {
      ...f.input,
      toolName: 'patch',
      toolInput: { patch: 'diff' },
      toolResult: {
        content: 'patched',
        isError: false,
        modifiedPaths: files,
        modifiedPathsOmitted: 2,
      },
    };
    const output = (await f.run(input))?.additionalContext ?? '';
    expect(f.pull).toHaveBeenCalledTimes(8);
    expect(output).toContain('4 additional file scope entries not checked');
    expect(output.length).toBeLessThan(8000);
    expect(output).toContain('[diagnostics truncated]');
    f.pull.mockResolvedValue([error]);
    const compact = (await f.run(input))?.additionalContext ?? '';
    expect(compact).toContain('Total: 3 diagnostics in 3 files.');
    expect((compact.match(/ERROR typescript/g) ?? []).length).toBe(3);
  });

  it('does not call an unchecked bulk scope clean or check a preview', async () => {
    const f = await fixture();
    const missing = await f.run({ ...f.input, toolName: 'patch', toolInput: { patch: 'diff' } });
    expect(missing?.additionalContext).toContain('file scope unavailable');
    expect(missing?.additionalContext).not.toContain('No LSP diagnostics');
    await f.run({
      ...f.input,
      toolName: 'patch',
      toolInput: { dry_run: true },
      toolResult: { content: 'preview', isError: false, modifiedPaths: [f.file] },
    });
    await f.run({
      ...f.input,
      toolName: 'replace',
      toolInput: { files: '*.ts' },
      toolResult: { content: 'preview', isError: false, modifiedPaths: [] },
    });
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('rechecks the first file after analyzing the second file', async () => {
    const f = await fixture();
    f.cfg.diagnosticsWaitMs = 1000;
    const second = path.join(f.root, 'b.ts');
    await fs.writeFile(second, 'const b = 2;');
    f.pull.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      await fs.writeFile(f.file, 'changed while b was analyzed');
      return [];
    });
    const output =
      (
        await f.run({
          ...f.input,
          toolName: 'patch',
          toolInput: {},
          toolResult: { content: 'patched', isError: false, modifiedPaths: [f.file, second] },
        })
      )?.additionalContext ?? '';
    expect(output).toContain('a.ts": current diagnostics unavailable; file not verified');
    expect(output).toContain('Verified file(s): 1');
  });

  it('shares one deadline across files and marks remaining files unverified', async () => {
    const f = await fixture();
    const second = path.join(f.root, 'b.ts');
    await fs.writeFile(second, 'const b = 2;');
    f.cfg.diagnosticsWaitMs = 20;
    const started = Promise.withResolvers<void>();
    f.pull.mockImplementation(async (_uri, _waitMs, signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return [];
    });
    vi.useFakeTimers();
    try {
      const pending = f.run({
        ...f.input,
        toolName: 'patch',
        toolInput: {},
        toolResult: { content: 'patched', isError: false, modifiedPaths: [f.file, second] },
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(20);
      const output = (await pending)?.additionalContext ?? '';
      expect(f.pull).toHaveBeenCalledTimes(1);
      expect(output).toContain('a.ts": current diagnostics unavailable');
      expect(output).toContain('b.ts": current diagnostics unavailable');
      expect(output).not.toContain('No LSP diagnostics');
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes current diagnostics with exact document identity', async () => {
    const f = await fixture();
    const output = await f.run();
    expect(output).toMatchObject({ contextAs: 'inline' });
    expect(output?.additionalContext).toContain('ERROR typescript(2322)');
    expect(output?.additionalContext).toMatch(/version=1; sha256=[a-f0-9]{64}/);
    expect(output?.additionalContext).toContain('Tests/typecheck remain required');
  });

  it('reports a confirmed clean file separately from a failed check', async () => {
    const f = await fixture();
    f.pull.mockResolvedValue([]);
    expect((await f.run())?.additionalContext).toContain('No LSP diagnostics.');
    f.pull.mockRejectedValue(new Error('timeout'));
    const output = (await f.run())?.additionalContext;
    expect(output).toContain('file not verified');
    expect(output).not.toContain('No LSP diagnostics');
  });

  it('states the filter and received count when errors were filtered out', async () => {
    const f = await fixture();
    f.cfg.severityFilter = ['hint'];
    const output = (await f.run())?.additionalContext;
    expect(output).toContain('Received 1 diagnostics; displayed severities: hint');
    expect(output).toContain('No LSP diagnostics.');
  });

  it('rejects stale diagnostics if the file changes during analysis', async () => {
    const f = await fixture();
    f.pull.mockImplementation(async () => {
      await fs.writeFile(f.file, 'const b = 2;');
      return [];
    });
    expect((await f.run())?.additionalContext).toContain('file not verified');
  });

  it('rejects results from a replaced server', async () => {
    const f = await fixture();
    f.pull.mockImplementation(async () => {
      f.registry.get = () => null as never;
      return [];
    });
    expect((await f.run())?.additionalContext).toContain('file not verified');
  });

  it('discards results after the originating project/session leaves', async () => {
    const f = await fixture();
    f.pull.mockImplementation(async () => {
      f.leave();
      return [error];
    });
    expect(await f.run()).toBeUndefined();
  });

  it('does not check failed edits, unsupported files or manual mode', async () => {
    const f = await fixture();
    await f.run({ ...f.input, toolResult: { content: 'denied', isError: true } });
    await f.run({ ...f.input, toolInput: { path: path.join(f.root, 'notes.txt') } });
    f.cfg.diagnosticsAfterEdit = 'manual';
    await f.run();
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('does not mistake a silent push server for a verified file', async () => {
    const f = await fixture();
    f.server.capabilities = {};
    const output = await f.run();
    expect(output?.additionalContext).toContain('file not verified');
    expect(f.pull).not.toHaveBeenCalled();
  });

  it('verifies diagnostics returned by a push-only server', async () => {
    const f = await fixture();
    f.cfg.diagnosticsWaitMs = 1000;
    f.server.capabilities = {};
    const pushed = vi.spyOn(f.server, 'waitForDiagnostics').mockResolvedValue([error]);
    const output = await f.run();
    expect(pushed).toHaveBeenCalledOnce();
    expect(f.pull).not.toHaveBeenCalled();
    expect(output?.additionalContext).toContain('ERROR typescript(2322)');
    expect(output?.additionalContext).toContain('Verified file(s): 1');
  });

  it('drops feedback on cancellation and bounds diagnostic text', async () => {
    const f = await fixture();
    const aborted = new AbortController();
    aborted.abort();
    expect(await f.run(f.input, aborted.signal)).toBeUndefined();
    f.pull.mockResolvedValue([{ ...error, message: 'x'.repeat(20_000) }]);
    const output = (await f.run())?.additionalContext ?? '';
    expect(output.length).toBeLessThan(8000);
    expect(output).toContain('[diagnostics truncated]');
  });
});

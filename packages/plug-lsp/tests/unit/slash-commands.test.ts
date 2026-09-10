import { describe, expect, it, vi } from 'vitest';
import { diagnosticsCommand } from '../../src/slash-commands/diagnostics.js';
import { registerSlashCommands } from '../../src/slash-commands/index.js';
import { listCommand } from '../../src/slash-commands/list.js';
import { restartCommand } from '../../src/slash-commands/restart.js';
import { startCommand } from '../../src/slash-commands/start.js';
import { stopCommand } from '../../src/slash-commands/stop.js';
import { pathToUri, uriKey } from '../../src/utils/uri.js';

describe('slash commands', () => {
  it('lists configured servers and empty state', async () => {
    expect((await listCommand({ list: () => [] } as never).run('', ctx())).message).toBe(
      'No LSP servers configured.',
    );
    const message = (await listCommand({ list: () => [server('ts')] } as never).run('', ctx()))
      .message;
    expect(message).toContain('ts');
    expect(message).toContain('typescript');
  });

  it('starts, stops, and restarts with usage messages', async () => {
    const registry = { start: vi.fn(), stop: vi.fn(), restart: vi.fn() };
    expect((await startCommand(registry as never).run(' ', ctx())).message).toContain('Usage');
    expect((await stopCommand(registry as never).run('', ctx())).message).toContain('Usage');
    expect((await restartCommand(registry as never).run('', ctx())).message).toContain('Usage');
    expect((await startCommand(registry as never).run(' ts ', ctx())).message).toBe(
      'Started LSP server "ts".',
    );
    expect((await stopCommand(registry as never).run('ts', ctx())).message).toBe(
      'Stopped LSP server "ts".',
    );
    expect((await restartCommand(registry as never).run('ts', ctx())).message).toBe(
      'Restarted LSP server "ts".',
    );
    expect(registry.start).toHaveBeenCalledWith('ts');
    expect(registry.stop).toHaveBeenCalledWith('ts');
    expect(registry.restart).toHaveBeenCalledWith('ts');
  });

  it('prints buffered diagnostics', async () => {
    // `LSPServer.setDiagnostics` keys the buffer by `uriKey(uri)` — a normalized
    // path, not a URL — so the fixture must key it the same way or it exercises
    // a buffer shape production never produces.
    const key = uriKey(pathToUri(`${process.cwd()}/a.ts`));
    const srv = server('ts');
    srv.diagnostics.set(key, [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        message: 'bad',
      },
    ]);
    const message = (await diagnosticsCommand({ list: () => [srv] } as never).run('', ctx()))
      .message;
    expect(message).toContain('bad');
    expect(
      (await diagnosticsCommand({ list: () => [] } as never).run('', undefined as never))?.message,
    ).toBe('No LSP diagnostics.');
  });

  it('prints diagnostics for a key that is not a file: URL', async () => {
    // `uriKey` passes a non-`file:` URI through unchanged, so a server that
    // publishes under one would make `uriToPath` throw on it as well.
    const srv = server('ts');
    srv.diagnostics.set('untitled:Untitled-1', [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
        severity: 2,
        message: 'unsaved buffer warning',
      },
    ]);
    const command = diagnosticsCommand({ list: () => [srv] } as never);
    const result = await command.run('', ctx());
    if (!result) throw new Error('diagnostics command returned no result');
    expect(result.message).toContain('unsaved buffer warning');
  });

  it('aggregates buffered diagnostics across servers and files', async () => {
    const first = server('ts');
    first.diagnostics.set(uriKey(pathToUri(`${process.cwd()}/a.ts`)), [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        message: 'first error',
      },
    ]);
    const second = server('python');
    second.diagnostics.set(uriKey(pathToUri(`${process.cwd()}/b.py`)), [
      {
        range: { start: { line: 2, character: 1 }, end: { line: 2, character: 3 } },
        severity: 2,
        message: 'second warning',
      },
    ]);

    const command = diagnosticsCommand({ list: () => [first, second] } as never);
    const result = await command.run('', ctx());
    if (!result) throw new Error('diagnostics command returned no result');

    expect(result.message).toContain('first error');
    expect(result.message).toContain('second warning');
    expect(result.message).toContain('Total: 2 diagnostics in 2 files.');
  });

  it('merges diagnostics when two servers report the same file', async () => {
    // Two servers reporting one document land on the same `uriKey` key, so a
    // plain `set` would keep only the last server's diagnostics — `/lsp
    // diagnostics` merges, and so must this command.
    const key = uriKey(pathToUri(`${process.cwd()}/a.ts`));
    const first = server('ts');
    first.diagnostics.set(key, [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
        severity: 1,
        message: 'first server error',
      },
    ]);
    const second = server('vue');
    second.diagnostics.set(key, [
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } },
        severity: 2,
        message: 'second server warning',
      },
    ]);

    const command = diagnosticsCommand({ list: () => [first, second] } as never);
    const result = await command.run('', ctx());
    if (!result) throw new Error('diagnostics command returned no result');

    expect(result.message).toContain('first server error');
    expect(result.message).toContain('second server warning');
    expect(result.message).toContain('Total: 2 diagnostics in 1 files.');
  });

  it('registers command set and returns bare names', () => {
    const registered: string[] = [];
    const options = new Map<string, { bare?: boolean } | undefined>();
    const names = registerSlashCommands(
      {
        slashCommands: {
          register: (cmd: { name: string }, opts?: { bare?: boolean }) => {
            registered.push(cmd.name);
            options.set(cmd.name, opts);
          },
        },
      } as never,
      { list: () => [] } as never,
    );
    expect(names).toEqual(['lsp', 'list', 'start', 'stop', 'restart', 'diagnostics']);
    expect(registered).toEqual(names);
    expect(options.get('stop')).toEqual({ bare: false });
    expect(options.get('lsp')).toBeUndefined();
  });
});

function ctx() {
  return { cwd: process.cwd() } as never;
}

function server(name: string) {
  return {
    name,
    state: 'ready',
    rootPath: process.cwd(),
    config: { languages: ['typescript'] },
    diagnostics: new Map(),
  };
}

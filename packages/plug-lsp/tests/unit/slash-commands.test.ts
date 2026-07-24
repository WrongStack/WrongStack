import { describe, expect, it, vi } from 'vitest';
import { diagnosticsCommand } from '../../src/slash-commands/diagnostics.js';
import { registerSlashCommands } from '../../src/slash-commands/index.js';
import { listCommand } from '../../src/slash-commands/list.js';
import { restartCommand } from '../../src/slash-commands/restart.js';
import { startCommand } from '../../src/slash-commands/start.js';
import { stopCommand } from '../../src/slash-commands/stop.js';
import { pathToUri } from '../../src/utils/uri.js';

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
    const uri = pathToUri(`${process.cwd()}/a.ts`);
    const srv = server('ts');
    srv.diagnostics.set(uri, [
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

  it('registers command set and returns bare names', () => {
    const registered: string[] = [];
    const names = registerSlashCommands(
      {
        slashCommands: { register: (cmd: { name: string }) => registered.push(cmd.name) },
      } as never,
      { list: () => [] } as never,
    );
    expect(names).toEqual(['lsp', 'list', 'start', 'stop', 'restart', 'diagnostics']);
    expect(registered).toEqual(names);
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

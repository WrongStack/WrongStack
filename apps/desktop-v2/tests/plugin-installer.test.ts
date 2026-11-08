import { describe, expect, it, vi } from 'vitest';
import { runEngineText } from '../src/engine-command-run';
import { pluginSpec } from '../src/plugin-installer-model';

describe('plugin spec', () => {
  it('accepts official aliases and package names', () => {
    expect(pluginSpec('telegram')).toBe('telegram');
    expect(pluginSpec('  @wrongstack/plug-lsp ')).toBe('@wrongstack/plug-lsp');
    expect(pluginSpec('some.plugin_v2-x')).toBe('some.plugin_v2-x');
  });

  it('refuses anything that would add an option or a second argument', () => {
    // `--install` would make /plugin install run a package manager.
    for (const bad of ['', '   ', '--install', '-x', 'a b', 'telegram --install', 'a;b', 'a\nb']) {
      expect(pluginSpec(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('runEngineText', () => {
  it('runs the command by name, for the given conversation when there is one, and returns what it printed', async () => {
    const command = vi.fn(async () => ({ message: '  done \n' }));
    expect(await runEngineText(command as never, 'plugin', 'list')).toEqual({ text: 'done' });
    expect(command).toHaveBeenCalledWith('command.run', { name: 'plugin', args: 'list' }, [
      'command.result',
    ]);
    await runEngineText(command as never, 'permissions', 'list', 'sess_1');
    expect(command).toHaveBeenLastCalledWith(
      'command.run',
      { name: 'permissions', args: 'list', sessionId: 'sess_1' },
      ['command.result'],
    );
  });

  it('reports an error reply, and a request that failed', async () => {
    const refused = vi.fn(async () => ({ error: '/nope is not a command this engine runs.' }));
    expect(await runEngineText(refused as never, 'nope', '')).toEqual({
      text: '',
      error: '/nope is not a command this engine runs.',
    });
    const failing = vi.fn(async () => {
      throw new Error('timed out');
    });
    expect(await runEngineText(failing as never, 'plugin', 'list')).toEqual({
      text: '',
      error: 'timed out',
    });
  });
});

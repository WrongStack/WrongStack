import { describe, expect, it, vi } from 'vitest';
import { buildAuthCommand } from '../src/slash-commands/auth.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function makeContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    registry: {} as SlashCommandContext['registry'],
    toolRegistry: {} as SlashCommandContext['toolRegistry'],
    tokenCounter: { count: () => 0 } as never as SlashCommandContext['tokenCounter'],
    renderer: {} as SlashCommandContext['renderer'],
    events: {} as SlashCommandContext['events'],
    cwd: '/tmp/test',
    projectRoot: '/tmp/test',
    configStore: { get: () => ({}) } as SlashCommandContext['configStore'],
    reader: {} as SlashCommandContext['reader'],
    onPanelOpen: { current: null },
    ...overrides,
  };
}

describe('/auth slash command', () => {
  it('returns help on /auth help', async () => {
    const ctx = makeContext();
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('help');
    expect(result!.message).toContain('Usage:');
    expect(result!.message).toContain('/auth');
  });

  it('returns help on /auth --help', async () => {
    const ctx = makeContext();
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('--help');
    expect(result!.message).toContain('Usage:');
  });

  it('errors when config path is missing', async () => {
    const ctx = makeContext({ paths: undefined });
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('');
    expect(result!.message).toContain('Error');
    expect(result!.message).toContain('config path missing');
  });

  it('shows open hint with wstack auth instructions', async () => {
    const ctx = makeContext({
      paths: {
        globalConfig: '/tmp/does-not-exist.json',
        profileConfig: () => '/tmp/does-not-exist.json',
      } as unknown as SlashCommandContext['paths'],
    });
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('open');
    expect(result!.message).toContain('wstack auth');
    expect(result!.message).toContain('Interactive menu');
  });

  it('shows empty state when no providers', async () => {
    const ctx = makeContext({
      paths: {
        globalConfig: '/tmp/empty-config.json',
        profileConfig: () => '/tmp/empty-config.json',
      } as unknown as SlashCommandContext['paths'],
    });
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('');
    // When config doesn't exist, loadConfigProviders returns {}
    expect(result!.message).toContain('No providers configured');
  });

  it('shows usage on /auth status with no argument', async () => {
    const ctx = makeContext({
      paths: {
        globalConfig: '/tmp/empty-config.json',
        profileConfig: () => '/tmp/empty-config.json',
      } as unknown as SlashCommandContext['paths'],
    });
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('status');
    expect(result!.message).toContain('Usage:');
    expect(result!.message).toContain('status <provider>');
  });
});

describe('/auth — TUI panel bridge', () => {
  const paths = {
    globalConfig: '/tmp/empty-config.json',
    profileConfig: () => '/tmp/empty-config.json',
  } as unknown as SlashCommandContext['paths'];

  it('bare /auth opens the panel when the bridge is live', async () => {
    const current = vi.fn().mockReturnValue(true);
    const cmd = buildAuthCommand(makeContext({ paths, onPanelOpen: { current } }));
    const result = await cmd.run('');
    expect(current).toHaveBeenCalledWith('authOpen');
    expect(result!.message).toContain('Opened the auth panel');
  });

  it('/auth login opens the OAuth view when the bridge is live', async () => {
    const current = vi.fn().mockReturnValue(true);
    const cmd = buildAuthCommand(makeContext({ paths, onPanelOpen: { current } }));
    const result = await cmd.run('login');
    expect(current).toHaveBeenCalledWith('authOauthOpen');
    expect(result!.message).toContain('Opened OAuth sign-in');
  });

  it('falls back to the text listing when the bridge declines (no auth host)', async () => {
    const current = vi.fn().mockReturnValue(false);
    const cmd = buildAuthCommand(makeContext({ paths, onPanelOpen: { current } }));
    const result = await cmd.run('');
    expect(current).toHaveBeenCalledWith('authOpen');
    expect(result!.message).toContain('No providers configured');
  });

  it('/auth login falls back to the wstack auth login hint in the REPL', async () => {
    const cmd = buildAuthCommand(makeContext({ paths, onPanelOpen: { current: null } }));
    const result = await cmd.run('login');
    expect(result!.message).toContain('wstack auth login chatgpt');
  });
});

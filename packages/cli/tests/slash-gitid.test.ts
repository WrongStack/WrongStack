import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configureChildEnvGitIdentity,
  getChildEnvGitIdentity,
  stripAnsi,
} from '@wrongstack/core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGitIdCommand } from '../src/slash-commands/gitid.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function makeCtx(initial: Record<string, unknown> = {}) {
  const wsDir = mkdtempSync(path.join(tmpdir(), 'wstack-gitid-'));
  const globalConfig = path.join(wsDir, 'config.json');
  const profileConfig = path.join(wsDir, 'profiles', 'default', 'config.json');
  const seed = { provider: 'anthropic', model: 'opus', providers: {}, ...initial };
  writeFileSync(globalConfig, JSON.stringify({ version: 1, activeProfile: 'default' }, null, 2));
  mkdirSync(path.dirname(profileConfig), { recursive: true });
  writeFileSync(profileConfig, JSON.stringify(seed, null, 2));
  let live: Record<string, unknown> = { ...seed };
  const update = vi.fn((patch: Record<string, unknown>) => {
    live = { ...live, ...patch };
  });
  const ctx = {
    configStore: { get: vi.fn(() => live), update },
    paths: { globalConfig, profileConfig: () => profileConfig },
  } as never as SlashCommandContext;
  const readFile = () => JSON.parse(readFileSync(profileConfig, 'utf8')) as Record<string, unknown>;
  return { ctx, update, readFile, getLive: () => live };
}

describe('/gitid', () => {
  afterEach(() => {
    // The command mutates module-level state in core — reset between tests.
    configureChildEnvGitIdentity(null);
  });

  it('shows "not set" with no args and no identity', async () => {
    const { ctx } = makeCtx();
    const cmd = buildGitIdCommand(ctx);
    const res = await cmd.run('');
    const msg = stripAnsi(res?.message ?? '');
    expect(msg).toContain('Commit identity');
    expect(msg).toContain('not set');
  });

  it('set persists identity to the active profile and applies it', async () => {
    const { ctx, update, readFile } = makeCtx();
    const cmd = buildGitIdCommand(ctx);
    const res = await cmd.run('set Alt Name alt@example.com');
    const msg = stripAnsi(res?.message ?? '');
    expect(msg).toContain('Alt Name');
    expect(msg).toContain('<alt@example.com>');
    expect(msg).toContain('persisted');
    expect(readFile().git).toEqual({ identity: { name: 'Alt Name', email: 'alt@example.com' } });
    expect(update).toHaveBeenCalledWith({
      git: { identity: { name: 'Alt Name', email: 'alt@example.com' } },
    });
    expect(getChildEnvGitIdentity()).toEqual({ name: 'Alt Name', email: 'alt@example.com' });
  });

  it('set with only an email leaves the name to git config', async () => {
    const { ctx, readFile } = makeCtx();
    const cmd = buildGitIdCommand(ctx);
    const res = await cmd.run('set alt@example.com');
    expect(stripAnsi(res?.message ?? '')).toContain('<alt@example.com>');
    expect(readFile().git).toEqual({ identity: { email: 'alt@example.com' } });
    expect(getChildEnvGitIdentity()).toEqual({ name: undefined, email: 'alt@example.com' });
  });

  it('set --session applies without writing the config file', async () => {
    const { ctx, update, readFile } = makeCtx();
    const cmd = buildGitIdCommand(ctx);
    const res = await cmd.run('set Alt Name alt@example.com --session');
    expect(stripAnsi(res?.message ?? '')).toContain('this session only');
    expect(readFile().git).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(getChildEnvGitIdentity()).toEqual({ name: 'Alt Name', email: 'alt@example.com' });
  });

  it('set rejects a last argument that is not an email', async () => {
    const { ctx, readFile } = makeCtx();
    const cmd = buildGitIdCommand(ctx);
    const res = await cmd.run('set Just A Name');
    expect(stripAnsi(res?.message ?? '')).toContain('does not look like an email');
    expect(readFile().git).toBeUndefined();
    expect(getChildEnvGitIdentity()).toBeNull();
  });

  it('clear removes the identity from config and runtime', async () => {
    const { ctx, readFile } = makeCtx({
      git: { identity: { name: 'Alt Name', email: 'alt@example.com' } },
    });
    configureChildEnvGitIdentity({ name: 'Alt Name', email: 'alt@example.com' });
    const cmd = buildGitIdCommand(ctx);
    const res = await cmd.run('clear');
    expect(stripAnsi(res?.message ?? '')).toContain('cleared');
    expect(readFile().git).toBeUndefined();
    expect(getChildEnvGitIdentity()).toBeNull();
  });

  it('show reflects an active identity', async () => {
    const { ctx } = makeCtx({
      git: { identity: { name: 'Alt Name', email: 'alt@example.com' } },
    });
    configureChildEnvGitIdentity({ name: 'Alt Name', email: 'alt@example.com' });
    const cmd = buildGitIdCommand(ctx);
    const res = await cmd.run('');
    const msg = stripAnsi(res?.message ?? '');
    expect(msg).toContain('Alt Name');
    expect(msg).toContain('alt@example.com');
    expect(msg).toContain('persisted');
  });

  it('rejects an unknown subcommand', async () => {
    const { ctx } = makeCtx();
    const cmd = buildGitIdCommand(ctx);
    const res = await cmd.run('frobnicate');
    expect(stripAnsi(res?.message ?? '')).toContain('Unknown subcommand');
  });
});

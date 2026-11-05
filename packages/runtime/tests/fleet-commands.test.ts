import { describe, expect, it, vi } from 'vitest';
import {
  buildDirectorCommand,
  buildSpawnCommand,
  buildSupervisorCommand,
  fleetSpawnCallbacks,
  parseSpawnFlags,
} from '../src/commands.js';

const quiet = { write: () => {}, writeInfo: () => {}, writeWarning: () => {} };
const inTab = (id: string) => ({ session: { id } }) as never;

describe('parseSpawnFlags', () => {
  it('returns empty opts when input is empty', () => {
    expect(parseSpawnFlags('')).toEqual({ description: '', opts: {} });
  });

  it('parses --provider= / --model=', () => {
    const r = parseSpawnFlags('--provider=openai --model=gpt-4 do something');
    expect(r.opts.provider).toBe('openai');
    expect(r.opts.model).toBe('gpt-4');
    expect(r.description).toBe('do something');
  });

  it('parses --provider= / --model= with quoted values', () => {
    const r = parseSpawnFlags('--provider="anthropic" --model="gpt-4o" audit the code');
    expect(r.opts.provider).toBe('anthropic');
    expect(r.opts.model).toBe('gpt-4o');
    expect(r.description).toBe('audit the code');
  });

  it('parses -p / -m with single-quoted values', () => {
    const r = parseSpawnFlags("-p 'openai' -m 'claude-sonnet-4' run checks");
    expect(r.opts.provider).toBe('openai');
    expect(r.opts.model).toBe('claude-sonnet-4');
    expect(r.description).toBe('run checks');
  });

  it('keeps quoted --model values containing spaces and preserves the description', () => {
    const r = parseSpawnFlags('--model="gpt 4" fix the auth bug');
    expect(r.opts.model).toBe('gpt 4');
    expect(r.description).toBe('fix the auth bug');
  });

  it('falls back to the raw token when a quote is unterminated', () => {
    const r = parseSpawnFlags('--model="gpt-4o fix it');
    expect(r.opts.model).toBe('"gpt-4o');
    expect(r.description).toBe('fix it');
  });

  it('parses --name= with quoted value', () => {
    const r = parseSpawnFlags('--name="bug hunter" find bugs');
    expect(r.opts.name).toBe('bug hunter');
    expect(r.description).toBe('find bugs');
  });

  it('parses --name= unquoted', () => {
    const r = parseSpawnFlags('--name=quick run it');
    expect(r.opts.name).toBe('quick');
    expect(r.description).toBe('run it');
  });

  it('parses --tools= and splits on commas', () => {
    const r = parseSpawnFlags('--tools=read,grep,write do task');
    expect(r.opts.tools).toEqual(['read', 'grep', 'write']);
    expect(r.description).toBe('do task');
  });

  it('parses -p / -m / -n short flags', () => {
    const r = parseSpawnFlags('-p openai -m gpt-4 -n agent7 chase the bug');
    expect(r.opts.provider).toBe('openai');
    expect(r.opts.model).toBe('gpt-4');
    expect(r.opts.name).toBe('agent7');
    expect(r.description).toBe('chase the bug');
  });

  it('handles -n with quoted multi-word name', () => {
    const r = parseSpawnFlags('-n "code monkey" hello');
    expect(r.opts.name).toBe('code monkey');
    expect(r.description).toBe('hello');
  });

  it('stops at the first non-flag and returns rest as description', () => {
    const r = parseSpawnFlags('describe this task');
    expect(r.opts).toEqual({});
    expect(r.description).toBe('describe this task');
  });

  it('trims trailing whitespace from description', () => {
    const r = parseSpawnFlags('--provider=x   hello world   ');
    expect(r.description).toBe('hello world');
  });

  it('handles all flags together', () => {
    const r = parseSpawnFlags(
      '--provider=openai --model=gpt-4 --name="my agent" --tools=a,b do it',
    );
    expect(r.opts.provider).toBe('openai');
    expect(r.opts.model).toBe('gpt-4');
    expect(r.opts.name).toBe('my agent');
    expect(r.opts.tools).toEqual(['a', 'b']);
    expect(r.description).toBe('do it');
  });

  it('handles space-separated long flags and equal-separated short flags', () => {
    const r = parseSpawnFlags(
      '--provider openai --model gpt-4 -n="custom agent" -p=anthropic fix issue',
    );
    expect(r.opts.provider).toBe('anthropic');
    expect(r.opts.model).toBe('gpt-4');
    expect(r.opts.name).toBe('custom agent');
    expect(r.description).toBe('fix issue');
  });
});

describe('fleet commands', () => {
  it('/spawn starts a worker for the asking conversation', async () => {
    const onSpawn = vi.fn(async () => 'Spawned w1');
    const spawn = buildSpawnCommand({ renderer: quiet, onSpawn });
    expect((await spawn.run('-m gpt-4o audit core', inTab('tab-2')))?.message).toBe('Spawned w1');
    expect(onSpawn).toHaveBeenCalledWith('audit core', {
      model: 'gpt-4o',
      originSessionId: 'tab-2',
    });
    // No flags and no conversation: the host's defaults.
    await spawn.run('audit core');
    expect(onSpawn).toHaveBeenLastCalledWith('audit core');
  });

  it('says so when the host has no fleet or no supervisor', async () => {
    const spawn = buildSpawnCommand({ renderer: quiet });
    expect((await spawn.run('task'))?.message).toBe('Multi-agent is not enabled in this session.');
    const director = buildDirectorCommand({ renderer: quiet });
    expect((await director.run(''))?.message).toBe(
      'Director promotion is not available in this session.',
    );
    const supervisor = buildSupervisorCommand({ renderer: quiet, getFleetSupervisor: () => null });
    expect((await supervisor.run(''))?.message).toContain('No fleet supervisor is active');
  });
});

describe('fleetSpawnCallbacks', () => {
  const director = { spawn: vi.fn(async () => 'w-role') };
  const host = {
    spawn: vi.fn(async () => ({ subagentId: 'w1', taskId: 't1' })),
    ensureDirector: vi.fn(async () => director as never),
  };

  it('summarises a spawn and brings the Director up for a role', async () => {
    const callbacks = fleetSpawnCallbacks({
      host,
      getDirector: () => undefined,
      getSessionId: () => 'boot',
    });
    expect(await callbacks.onSpawn('fix it', { name: 'fixer', model: 'm' })).toBe(
      'Spawned subagent w1 (m / "fixer") for task t1. Use /agents to track progress.',
    );
    expect(await callbacks.onFleetSpawn('debugger', 'tab-2')).toBe('w-role');
    expect(host.ensureDirector).toHaveBeenCalled();
    expect(director.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ originSessionId: 'tab-2' }),
    );
    await callbacks.onFleetSpawn('debugger');
    expect(director.spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ originSessionId: 'boot' }),
    );
    expect(await callbacks.onDirector()).toBe('Director mode is active.');
  });

  it('fails a role spawn when no Director can come up', async () => {
    const callbacks = fleetSpawnCallbacks({
      host: { ...host, ensureDirector: async () => null },
      getDirector: () => null,
      getSessionId: () => 'boot',
    });
    await expect(callbacks.onFleetSpawn('debugger')).rejects.toThrow('Director is not available.');
    expect(await callbacks.onDirector()).toBe('Director is not available.');
  });
});

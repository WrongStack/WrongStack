import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { buildAuditCommand } from '../src/slash-commands/audit.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function makeOpts(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    onPanelOpen: { current: null },
    ...overrides,
  } as never as SlashCommandContext;
}

function makeContext(sideEffects?: unknown): Context {
  return {
    sideEffects: sideEffects ?? [],
  } as never as Context;
}

describe('buildAuditCommand', () => {
  it('returns unavailable message when context is missing', async () => {
    const cmd = buildAuditCommand(makeOpts({ context: undefined }));
    const res = await cmd.run('');
    expect(res?.message).toBe('Audit not available in this context.');
  });

  it('returns empty message when no side effects recorded', async () => {
    const ctx = makeContext([]);
    const cmd = buildAuditCommand(makeOpts({ context: ctx }));
    const res = await cmd.run('');
    expect(res?.message).toBe('No side effects recorded yet.');
  });

  it('opens TUI panel when onPanelOpen is wired and no filter args', async () => {
    const onPanelOpen = vi.fn().mockReturnValue(true);
    const cmd = buildAuditCommand(
      makeOpts({
        context: makeContext(),
        onPanelOpen: { current: onPanelOpen },
      }),
    );
    const res = await cmd.run('');
    expect(onPanelOpen).toHaveBeenCalledWith('toggleAuditPanel');
    expect(res?.message).toBe('');
  });

  it('renders side effects list when TUI panel callback returns false', async () => {
    const onPanelOpen = vi.fn().mockReturnValue(false);
    const sideEffects = [
      {
        ts: '2026-07-11T10:00:00.000Z',
        toolName: 'bash',
        risk: 'low',
        input: { command: 'echo hello' },
        outcome: 'done',
      },
      {
        ts: '2026-07-11T10:01:00.000Z',
        toolName: 'install',
        risk: 'high',
        input: { packages: 'some-pkg' },
      },
    ];
    const cmd = buildAuditCommand(
      makeOpts({
        context: makeContext(sideEffects),
        onPanelOpen: { current: onPanelOpen },
      }),
    );
    const res = await cmd.run('');
    expect(res?.message).toContain('Side Effects (last 2)');
    expect(res?.message).toContain('bash');
    expect(res?.message).toContain('install');
    expect(res?.message).toContain('low');
    expect(res?.message).toContain('high');
  });

  it('filters by risk level', async () => {
    const sideEffects = [
      {
        ts: '2026-07-11T10:00:00.000Z',
        toolName: 'bash',
        risk: 'low',
        input: { command: 'echo hello' },
      },
      {
        ts: '2026-07-11T10:01:00.000Z',
        toolName: 'install',
        risk: 'high',
        input: { packages: 'some-pkg' },
      },
    ];
    const cmd = buildAuditCommand(makeOpts({ context: makeContext(sideEffects) }));
    const res = await cmd.run('high');
    expect(res?.message).toContain('risk=high');
    expect(res?.message).toContain('install');
    expect(res?.message).not.toContain('bash');
  });

  it('filters by tool name', async () => {
    const sideEffects = [
      {
        ts: '2026-07-11T10:00:00.000Z',
        toolName: 'bash',
        risk: 'low',
        input: { command: 'echo' },
      },
      {
        ts: '2026-07-11T10:01:00.000Z',
        toolName: 'install',
        risk: 'medium',
        input: { packages: 'pkg' },
      },
    ];
    const cmd = buildAuditCommand(makeOpts({ context: makeContext(sideEffects) }));
    const res = await cmd.run('tool bash');
    expect(res?.message).toContain('tool~bash');
    expect(res?.message).toContain('bash');
    expect(res?.message).not.toContain('install');
  });

  it('filters by count limit', async () => {
    const sideEffects = Array.from({ length: 10 }, (_, i) => ({
      ts: `2026-07-11T1${i}:00:00.000Z`,
      toolName: 'bash',
      risk: 'low',
      input: { command: `cmd${i}` },
    }));
    const cmd = buildAuditCommand(makeOpts({ context: makeContext(sideEffects) }));
    const res = await cmd.run('3');
    expect(res?.message).toContain('last 3');
  });

  it('returns empty result when filter matches nothing', async () => {
    const sideEffects = [
      {
        ts: '2026-07-11T10:00:00.000Z',
        toolName: 'bash',
        risk: 'low',
        input: { command: 'echo' },
      },
    ];
    const cmd = buildAuditCommand(makeOpts({ context: makeContext(sideEffects) }));
    const res = await cmd.run('critical');
    expect(res?.message).toMatch(/No side effects match the filter/);
    expect(res?.message).toContain('risk=critical');
  });

  it('handles --risk flag syntax', async () => {
    const sideEffects = [
      {
        ts: '2026-07-11T10:00:00.000Z',
        toolName: 'bash',
        risk: 'critical',
        input: { command: 'rm -rf /' },
      },
      {
        ts: '2026-07-11T10:01:00.000Z',
        toolName: 'bash',
        risk: 'low',
        input: { command: 'echo hi' },
      },
    ];
    const cmd = buildAuditCommand(makeOpts({ context: makeContext(sideEffects) }));
    const res = await cmd.run('--risk critical');
    expect(res?.message).toContain('rm -rf');
    expect(res?.message).not.toContain('echo hi');
  });
});

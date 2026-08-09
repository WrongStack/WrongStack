import { describe, expect, it, vi } from 'vitest';
import { createCliSecurityCommand } from '../src/wiring/security-command.js';

function host() {
  return {
    cwd: 'C:/cwd',
    projectRoot: 'C:/project',
    llmProvider: { id: 'provider' } as never,
    llmModel: 'host-model',
  };
}

describe('createCliSecurityCommand', () => {
  it('exposes stable command metadata', () => {
    const command = createCliSecurityCommand(host(), { run: vi.fn() });

    expect(command).toMatchObject({
      name: 'security',
      category: 'Inspect',
      argsHint: expect.stringContaining('audit-deps'),
      help: expect.stringContaining('Usage: /security'),
    });
  });

  it('constructs the package backend by default', () => {
    expect(createCliSecurityCommand(host())).toMatchObject({
      name: 'security',
      run: expect.any(Function),
    });
  });

  it('rejects unknown subcommands in text and JSON modes', async () => {
    const backend = { run: vi.fn() };
    const command = createCliSecurityCommand(host(), backend);

    await expect(command.run('unknown', {} as never)).resolves.toEqual(
      expect.objectContaining({
        message: 'Unknown /security subcommand: unknown',
        metadata: {
          security: expect.objectContaining({
            ok: false,
            action: 'unknown',
            error: expect.objectContaining({ code: 'unknown_subcommand' }),
          }),
        },
      }),
    );
    const jsonResult = await command.run('unknown --json', {} as never);
    expect(JSON.parse(jsonResult?.message ?? '')).toEqual(
      expect.objectContaining({ ok: false, action: 'unknown' }),
    );
    expect(backend.run).not.toHaveBeenCalled();
  });

  it('normalizes empty and help aliases and supplies host context defaults', async () => {
    const backend = { run: vi.fn().mockResolvedValue({ message: 'help' }) };
    const command = createCliSecurityCommand(host(), backend);

    for (const args of ['', '--help', '-h']) {
      const result = await command.run(args, {} as never);
      expect(result?.metadata?.security).toEqual(
        expect.objectContaining({
          ok: true,
          action: 'help',
          subcommands: ['scan', 'audit', 'audit-deps', 'report', 'redact-test', 'help'],
        }),
      );
    }
    expect(backend.run).toHaveBeenNthCalledWith(
      1,
      'help',
      expect.objectContaining({
        cwd: 'C:/cwd',
        projectRoot: 'C:/project',
        provider: host().llmProvider,
        model: 'host-model',
      }),
    );
    expect(backend.run).toHaveBeenNthCalledWith(2, 'help', expect.any(Object));
  });

  it('preserves current execution context and strips JSON from backend arguments', async () => {
    const backend = {
      run: vi.fn().mockResolvedValue({
        message: 'scan complete',
        metadata: { findingCount: 2 },
      }),
    };
    const command = createCliSecurityCommand(host(), backend);
    const current = {
      cwd: 'C:/override',
      projectRoot: 'C:/override-project',
      provider: { id: 'override-provider' },
      model: 'override-model',
    };

    const result = await command.run('scan --depth quick --json', current as never);
    expect(backend.run).toHaveBeenCalledWith('scan --depth quick', current);
    expect(JSON.parse(result?.message ?? '')).toEqual({
      ok: true,
      action: 'scan',
      findingCount: 2,
    });
    expect(result?.metadata).toEqual({
      findingCount: 2,
      security: { ok: true, action: 'scan', findingCount: 2 },
    });
  });

  it('projects backend failures and handles an empty backend response', async () => {
    const backend = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ message: '❌ scan failed', metadata: { stage: 'scan' } })
        .mockResolvedValueOnce(undefined),
    };
    const command = createCliSecurityCommand(host(), backend);

    const failed = await command.run('audit', {} as never);
    expect(failed).toEqual({
      message: '❌ scan failed',
      metadata: {
        stage: 'scan',
        security: {
          ok: false,
          action: 'audit',
          stage: 'scan',
          error: { code: 'security_command_failed', message: 'scan failed' },
        },
      },
    });

    await expect(command.run('report', {} as never)).resolves.toEqual({
      message: undefined,
      metadata: { security: { ok: true, action: 'report' } },
    });
  });

  it('uses an empty model when neither current nor host context supplies one', async () => {
    const backend = { run: vi.fn().mockResolvedValue({ message: 'ok' }) };
    const command = createCliSecurityCommand({ cwd: 'C:/cwd', projectRoot: 'C:/project' }, backend);

    await command.run('scan', {} as never);
    expect(backend.run).toHaveBeenCalledWith(
      'scan',
      expect.objectContaining({ model: '', provider: undefined }),
    );
  });
});

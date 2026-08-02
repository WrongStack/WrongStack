import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  governanceCmd,
  runGovernanceStatusCommand,
} from '../src/subcommands/handlers/governance.js';
import { subcommands } from '../src/subcommands/index.js';

function deps(json = false) {
  return {
    projectRoot: 'D:/project',
    flags: json ? { json: true } : {},
    renderer: {
      write: vi.fn(),
      writeError: vi.fn(),
    },
  } as never as Parameters<typeof governanceCmd>[1];
}

function degradedResult() {
  return {
    available: true as const,
    status: {
      schemaVersion: 1 as const,
      projectId: 'project-1',
      pid: 42,
      instanceId: 'instance-1',
      startedAt: '2026-08-02T12:00:00.000Z',
      signal: {
        level: 'warning' as const,
        code: 'attachment_broker_degraded' as const,
        message: 'Attachment broker renewal health is degraded.',
        operatorAction: 'investigate' as const,
        executionDisposition: 'continue' as const,
      },
      attachmentBroker: {
        state: 'retry_wait' as const,
        health: 'degraded' as const,
        expiresAt: '2026-08-02T13:00:00.000Z',
        consecutiveFailures: 3,
        pendingRevocations: 0,
        auditHealthy: true,
      },
    },
  };
}

describe('governance status subcommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is registered as a lazy top-level subcommand', () => {
    expect(subcommands['governance']).toBeTypeOf('function');
  });

  it('prints an advisory warning without returning a task-stopping exit code', async () => {
    const commandDeps = deps();
    const code = await runGovernanceStatusCommand([], commandDeps, {
      readStatus: vi.fn(async () => degradedResult()),
    });

    expect(code).toBe(0);
    const output = (commandDeps.renderer.write as ReturnType<typeof vi.fn>).mock.calls.join('\n');
    expect(output).toContain('Operator signal: warning (attachment_broker_degraded)');
    expect(output).toContain('Execution: continue');
    expect(output).toContain('no automatic task or model stop');
  });

  it('emits stable JSON without credentials', async () => {
    const commandDeps = deps(true);
    const code = await runGovernanceStatusCommand([], commandDeps, {
      readStatus: vi.fn(async () => degradedResult()),
    });

    expect(code).toBe(0);
    const output = (commandDeps.renderer.write as ReturnType<typeof vi.fn>).mock.calls.join('\n');
    expect(JSON.parse(output)).toMatchObject({
      available: true,
      status: { signal: { executionDisposition: 'continue' } },
    });
    expect(output).not.toContain('wsg_');
    expect(output).not.toContain('credential');
  });

  it('returns non-zero only when status cannot be read', async () => {
    const commandDeps = deps();
    const code = await runGovernanceStatusCommand([], commandDeps, {
      readStatus: vi.fn(async () => ({
        available: false as const,
        code: 'broker_missing' as const,
        message: 'Governance attachment broker is not published for this project.',
      })),
    });

    expect(code).toBe(1);
    expect(commandDeps.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('broker_missing'),
    );
  });

  it('documents the narrow status-only command surface', async () => {
    const commandDeps = deps();
    await expect(governanceCmd(['help'], commandDeps)).resolves.toBe(0);
    expect(commandDeps.renderer.write).toHaveBeenCalledWith(
      expect.stringContaining('wstack governance status [--json]'),
    );

    await expect(governanceCmd(['shutdown'], commandDeps)).resolves.toBe(1);
    expect(commandDeps.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown governance subcommand'),
    );
  });
});

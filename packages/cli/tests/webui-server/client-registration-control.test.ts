/**
 * The WebUI client must be HQ-controllable exactly like CLI/TUI — advertising
 * `control.receive` and wiring an onCommand dispatcher — when the host passes
 * control hooks; and stay telemetry-only (no control.receive, no onCommand)
 * when it doesn't. These tests pin that contract by capturing the options the
 * registration hands to `startCliHqConnection`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startCliHqConnection = vi.hoisted(() =>
  vi.fn(() => ({ getPublisher: () => undefined, stop: () => {} })),
);
const mailboxSend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const registerClient = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const clientHeartbeat = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const deregisterClient = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/hq-publisher.js', () => ({ startCliHqConnection }));
vi.mock('@wrongstack/core/coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/coordination')>();
  return {
    ...actual,
    resolveProjectDir: () => '/tmp/proj-dir',
    getSharedProjectMailbox: vi.fn(() => ({
      send: mailboxSend,
      registerClient,
      clientHeartbeat,
      deregisterClient,
    })),
  };
});
vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return { ...actual, wstackGlobalRoot: () => '/tmp/global' };
});

import { createWebuiClientRegistration } from '../../src/webui-server/client-registration.js';

function baseDeps() {
  return {
    projectRoot: '/tmp/proj',
    appConfig: undefined,
    events: { on: () => () => {}, emit: () => {} } as never,
    hqSessionId: 'sess-1',
    getSessionId: () => 'sess-live',
  };
}

beforeEach(() => {
  startCliHqConnection.mockClear();
  mailboxSend.mockClear();
});

describe('createWebuiClientRegistration — HQ control capability', () => {
  it('stays telemetry-only without control hooks', async () => {
    const reg = createWebuiClientRegistration(baseDeps());
    await reg.register();
    const opts = startCliHqConnection.mock.calls[0]![0] as {
      capabilities: string[];
      onCommand?: unknown;
      clientKind: string;
    };
    expect(opts.clientKind).toBe('webui');
    expect(opts.capabilities).not.toContain('control.receive');
    expect(opts.onCommand).toBeUndefined();
  });

  it('advertises control.receive and wires onCommand when hooks are supplied', async () => {
    const interruptLeader = vi.fn(() => true);
    const reg = createWebuiClientRegistration({
      ...baseDeps(),
      hqControl: { interruptLeader, allowRunCommand: () => false },
    });
    await reg.register();
    const opts = startCliHqConnection.mock.calls[0]![0] as {
      capabilities: string[];
      onCommand?: (cmd: { commandId: string; type: string; payload: unknown }) => Promise<unknown>;
    };
    expect(opts.capabilities).toContain('control.receive');
    expect(typeof opts.onCommand).toBe('function');
  });

  it('routes an HQ steer command through the WebUI mailbox', async () => {
    const reg = createWebuiClientRegistration({
      ...baseDeps(),
      hqControl: { interruptLeader: () => false, allowRunCommand: () => false },
    });
    await reg.register();
    const opts = startCliHqConnection.mock.calls[0]![0] as {
      onCommand: (cmd: { commandId: string; type: string; payload: unknown }) => Promise<{ status: string }>;
    };
    const result = await opts.onCommand({
      commandId: 'c1',
      type: 'steer',
      payload: { to: 'leader', subject: 'hi', body: 'do the thing' },
    });
    expect(result.status).toBe('accepted');
    expect(mailboxSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'steer', to: 'leader', body: 'do the thing' }),
    );
  });

  it('aborts the WebUI run for an HQ abort command', async () => {
    const interruptLeader = vi.fn(() => true);
    const reg = createWebuiClientRegistration({
      ...baseDeps(),
      hqControl: { interruptLeader, allowRunCommand: () => false },
    });
    await reg.register();
    const opts = startCliHqConnection.mock.calls[0]![0] as {
      onCommand: (cmd: { commandId: string; type: string; payload: unknown }) => Promise<{ status: string }>;
    };
    const result = await opts.onCommand({
      commandId: 'c2',
      type: 'abort',
      payload: { target: 'leader' },
    });
    expect(interruptLeader).toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('rejects run-command unless the operator opted in', async () => {
    const reg = createWebuiClientRegistration({
      ...baseDeps(),
      hqControl: { interruptLeader: () => false, allowRunCommand: () => false },
    });
    await reg.register();
    const opts = startCliHqConnection.mock.calls[0]![0] as {
      onCommand: (cmd: { commandId: string; type: string; payload: unknown }) => Promise<{ status: string }>;
    };
    const result = await opts.onCommand({
      commandId: 'c3',
      type: 'run-command',
      payload: { command: 'rm -rf /' },
    });
    expect(result.status).toBe('rejected');
  });
});

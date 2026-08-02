import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { launchGovernanceProjectDaemonWithRuntime } from '../src/daemon-launcher.js';
import {
  connectGovernanceAdminSession,
  connectGovernanceAdminSessionFromLaunch,
  connectGovernanceProjectClient,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  type GovernanceModelCapability,
  inspectGovernanceDaemon,
  readGovernanceDaemonMetadata,
} from '../src/index.js';
import { prepareGovernanceCompatibilityRuntimeWithAdapters } from '../src/runtime-compatibility.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const daemonEntrypoint = new URL('../src/project-daemon.ts', import.meta.url);
const temporaryDirectories: string[] = [];
const daemonPids = new Set<number>();

function projectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'wrongstack-governance-compat-'));
  temporaryDirectories.push(root);
  return root;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDaemon(pid: number): Promise<void> {
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // It exited between the liveness check and signal delivery.
    }
  }
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (isAlive(pid)) throw new Error(`Governance compatibility daemon ${pid} did not stop.`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  daemonPids.delete(pid);
}

async function waitForGracefulStop(root: string, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid) && (await readGovernanceDaemonMetadata(root)).kind === 'missing') {
      daemonPids.delete(pid);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Governance compatibility daemon ${pid} did not clean up gracefully.`);
}

async function launch(root: string, clientId: string) {
  const result = await launchGovernanceProjectDaemonWithRuntime(
    {
      projectRoot: root,
      projectId: 'compat-project',
      clientId,
      capabilities: ['capability_admin', 'daemon_control', 'workspace_snapshot_record'],
      ttlMs: 60_000,
      timeoutMs: 10_000,
    },
    {
      entrypoint: daemonEntrypoint,
      execArgv: ['--import', 'tsx'],
      cwd: repositoryRoot,
      detached: true,
    },
  );
  daemonPids.add(result.pid);
  return result;
}

const adapters = {
  inspect: inspectGovernanceDaemon,
  launch: async (options: Parameters<typeof launchGovernanceProjectDaemonWithRuntime>[0]) => {
    const result = await launchGovernanceProjectDaemonWithRuntime(options, {
      entrypoint: daemonEntrypoint,
      execArgv: ['--import', 'tsx'],
      cwd: repositoryRoot,
      detached: true,
    });
    daemonPids.add(result.pid);
    return result;
  },
  connectAttached: connectGovernanceAdminSession,
  connectLaunched: connectGovernanceAdminSessionFromLaunch,
  connectModel: connectGovernanceProjectClient,
};

function options(root: string) {
  return {
    projectRoot: root,
    projectId: 'compat-project',
    adminClientId: 'compat-admin',
    modelClientId: 'autonomous-model',
    modelCapabilities: ['task_read', 'command_submit', 'shadow_observe'] as const,
    adminTtlMs: 60_000,
    modelTtlMs: 30_000,
    timeoutMs: 10_000,
    adminLease: { startLease: false },
  };
}

afterEach(async () => {
  for (const pid of [...daemonPids]) await stopDaemon(pid);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('governance runtime compatibility factory', () => {
  it('launches an opt-in owner and gives the model autonomous but non-control access', async () => {
    const root = projectRoot();
    const prepared = await prepareGovernanceCompatibilityRuntimeWithAdapters(
      options(root),
      adapters,
    );
    expect(prepared).toMatchObject({
      mode: 'governed',
      runtime: {
        model: expect.any(Object),
      },
    });
    if (prepared.mode !== 'governed') throw new Error(prepared.message);
    const snapshot = prepared.runtime.snapshot();
    expect(snapshot).toMatchObject({
      source: 'launched',
      closed: false,
      admin: { mode: 'launched', daemon: { projectId: 'compat-project' } },
      model: {
        clientId: 'autonomous-model',
        capabilities: ['task_read', 'command_submit', 'shadow_observe'],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('wsg_');

    await expect(
      prepared.runtime.model.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'model-read-task',
        type: 'read_task',
        taskId: 'not-created-yet',
      }),
    ).resolves.toMatchObject({ ok: true, result: { type: 'task', task: null } });
    await expect(
      prepared.runtime.model.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'model-submit-command',
        type: 'submit_command',
        command: {
          type: 'transition_task',
          commandId: 'model-command',
          taskId: 'not-created-yet',
          expectedRevision: 0,
          actor: 'model',
          issuedAt: '2026-08-02T12:00:00.000Z',
          to: 'scoped',
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { type: 'command_result', execution: { decision: { code: 'task_missing' } } },
    });
    await expect(
      prepared.runtime.model.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'model-daemon-control',
        type: 'read_daemon_status',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    await expect(
      prepared.runtime.model.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'model-grant-admin',
        type: 'issue_capability_grant',
        clientId: 'model-selected-admin',
        capabilities: ['task_read'],
        ttlMs: 30_000,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    await expect(
      prepared.runtime.model.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'model-workspace-snapshot',
        type: 'record_workspace_snapshot',
        manifestHash: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    await expect(prepared.runtime.recordWorkspaceSnapshot('a'.repeat(64))).resolves.toMatchObject({
      ok: true,
      result: {
        type: 'workspace_snapshot_recorded',
        result: { recorded: true, snapshot: { projectId: 'compat-project', revision: 1 } },
      },
    });

    const pid = snapshot.admin.daemon.pid;
    await expect(
      prepared.runtime.shutdownDaemon('compatibility test complete'),
    ).resolves.toMatchObject({
      ok: true,
      result: { type: 'daemon_shutdown_accepted', requestedBy: 'compat-admin' },
    });
    await waitForGracefulStop(root, pid);
  });

  it('requires an explicit credential for an existing owner, then attaches without replacing it', async () => {
    const root = projectRoot();
    const existing = await launch(root, 'compat-admin');

    const unavailable = await prepareGovernanceCompatibilityRuntimeWithAdapters(
      options(root),
      adapters,
    );
    expect(unavailable).toEqual({
      mode: 'legacy',
      code: 'existing_owner_requires_credential',
      phase: 'inspect',
      message:
        'A governance daemon already owns this project; an explicit admin credential is required to attach.',
      cleanup: 'not_required',
    });
    expect(isAlive(existing.pid)).toBe(true);

    const prepared = await prepareGovernanceCompatibilityRuntimeWithAdapters(
      {
        ...options(root),
        existingAdmin: { grantId: existing.grantId, credential: existing.credential },
      },
      adapters,
    );
    expect(prepared).toMatchObject({ mode: 'governed' });
    if (prepared.mode !== 'governed') throw new Error(prepared.message);
    expect(prepared.runtime.snapshot()).toMatchObject({
      source: 'attached',
      admin: { mode: 'attached', daemon: { pid: existing.pid, instanceId: existing.instanceId } },
    });

    await expect(prepared.runtime.close()).resolves.toMatchObject({
      ok: true,
      result: { type: 'capability_grant_revoked', revoked: true },
    });
    expect(prepared.runtime.snapshot().closed).toBe(true);
    expect(isAlive(existing.pid)).toBe(true);
    await expect(
      prepared.runtime.model.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'closed-model-health',
        type: 'health',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'authentication_failed' } });
  });

  it('rolls back a newly launched owner when model connection verification fails', async () => {
    const root = projectRoot();
    const prepared = await prepareGovernanceCompatibilityRuntimeWithAdapters(options(root), {
      ...adapters,
      connectModel: async () => ({
        connected: false,
        code: 'service_rejected',
        message: 'simulated model connection rejection',
      }),
    });
    expect(prepared).toMatchObject({
      mode: 'legacy',
      code: 'model_connection_rejected',
      phase: 'provision',
      cleanup: 'launched_daemon_shutdown_requested',
    });
    const metadata = await readGovernanceDaemonMetadata(root);
    if (metadata.kind === 'valid') await waitForGracefulStop(root, metadata.metadata.pid);
    await expect(readGovernanceDaemonMetadata(root)).resolves.toEqual({ kind: 'missing' });
  });

  it('rolls back a verified launch when admin session construction throws', async () => {
    const root = projectRoot();
    const prepared = await prepareGovernanceCompatibilityRuntimeWithAdapters(options(root), {
      ...adapters,
      connectLaunched: async () => {
        throw new Error('simulated admin session construction failure');
      },
    });
    expect(prepared).toMatchObject({
      mode: 'legacy',
      code: 'admin_session_rejected',
      phase: 'launch',
      cleanup: 'launched_daemon_shutdown_requested',
    });
    const metadata = await readGovernanceDaemonMetadata(root);
    if (metadata.kind === 'valid') await waitForGracefulStop(root, metadata.metadata.pid);
    await expect(readGovernanceDaemonMetadata(root)).resolves.toEqual({ kind: 'missing' });
  });

  it('rejects model control capabilities before inspecting or launching anything', async () => {
    const root = projectRoot();
    let adapterCalled = false;
    const failIfCalled = async () => {
      adapterCalled = true;
      throw new Error('adapter must not be called');
    };
    const prepared = await prepareGovernanceCompatibilityRuntimeWithAdapters(
      {
        ...options(root),
        modelCapabilities: ['daemon_control'] as unknown as GovernanceModelCapability[],
      },
      {
        inspect: failIfCalled,
        launch: failIfCalled,
        connectAttached: failIfCalled,
        connectLaunched: failIfCalled,
        connectModel: failIfCalled,
      },
    );
    expect(prepared).toMatchObject({
      mode: 'legacy',
      code: 'invalid_options',
      phase: 'validate',
      cleanup: 'not_required',
    });
    expect(adapterCalled).toBe(false);
  });
});

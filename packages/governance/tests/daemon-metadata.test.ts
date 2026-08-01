import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireGovernanceDaemonStartupLease,
  connectGovernanceProjectClient,
  createGovernanceDaemonMetadata,
  governanceDaemonMetadataPath,
  governanceDaemonStartupLeasePath,
  inspectGovernanceDaemon,
  readGovernanceDaemonMetadata,
  removeOwnedGovernanceDaemonMetadata,
  shouldRecoverGovernanceEndpoint,
  writeGovernanceDaemonMetadata,
} from '../src/index.js';

const temporaryDirectories: string[] = [];
const startedAt = '2026-08-01T12:00:00.000Z';

function projectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'wrongstack-governance-metadata-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('governance daemon metadata', () => {
  it('persists only strict public liveness identity and removes only the current owner', async () => {
    const root = projectRoot();
    const metadata = createGovernanceDaemonMetadata({
      projectRoot: root,
      projectId: 'project-one',
      pid: 101,
      instanceId: 'instance-one',
      startedAt,
    });

    await writeGovernanceDaemonMetadata(root, metadata);

    await expect(readGovernanceDaemonMetadata(root)).resolves.toEqual({ kind: 'valid', metadata });
    const serialized = readFileSync(governanceDaemonMetadataPath(root), 'utf8');
    expect(serialized).not.toMatch(/token|credential|capabilities|clientId/u);
    await expect(
      removeOwnedGovernanceDaemonMetadata(root, { pid: 101, instanceId: 'other-instance' }),
    ).resolves.toBe(false);
    expect(existsSync(governanceDaemonMetadataPath(root))).toBe(true);
    await expect(removeOwnedGovernanceDaemonMetadata(root, metadata)).resolves.toBe(true);
    expect(existsSync(governanceDaemonMetadataPath(root))).toBe(false);
  });

  it('rejects injected fields without deleting the invalid metadata', async () => {
    const root = projectRoot();
    const metadata = createGovernanceDaemonMetadata({
      projectRoot: root,
      projectId: 'project-one',
      pid: 102,
      instanceId: 'instance-one',
      startedAt,
    });
    await writeGovernanceDaemonMetadata(root, metadata);
    writeFileSync(
      governanceDaemonMetadataPath(root),
      JSON.stringify({ ...metadata, token: 'must-not-be-accepted' }),
      'utf8',
    );

    const result = await readGovernanceDaemonMetadata(root);
    expect(result.kind).toBe('invalid');
    expect(existsSync(governanceDaemonMetadataPath(root))).toBe(true);
    await expect(
      connectGovernanceProjectClient({
        projectRoot: root,
        projectId: 'project-one',
        credential: {
          token: 'wsg_invalid.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
          projectId: 'project-one',
          clientId: 'model-reader',
        },
      }),
    ).resolves.toMatchObject({ connected: false, code: 'endpoint_invalid' });
  });

  it('classifies a missing owner and endpoint as stale', async () => {
    const inspection = await inspectGovernanceDaemon(projectRoot());

    expect(inspection).toEqual({ kind: 'stale', metadata: null, metadataState: 'missing' });
  });

  it('returns an explicit discovery result without starting a daemon or persisting credentials', async () => {
    const root = projectRoot();
    const credential = {
      token: 'wsg_missing.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
      projectId: 'project-one',
      clientId: 'model-reader',
    };

    await expect(
      connectGovernanceProjectClient({ projectRoot: root, projectId: 'project-one', credential }),
    ).resolves.toMatchObject({ connected: false, code: 'not_running' });
    expect(existsSync(governanceDaemonMetadataPath(root))).toBe(false);
    expect(existsSync(path.join(root, '.wrongstack'))).toBe(false);
    await expect(
      connectGovernanceProjectClient({
        projectRoot: root,
        projectId: 'other-project',
        credential,
      }),
    ).resolves.toMatchObject({ connected: false, code: 'credential_mismatch' });
  });
});

describe('governance daemon startup lease', () => {
  it('recovers a dead holder and prevents the prior holder from deleting its successor lease', async () => {
    const root = projectRoot();
    const first = await acquireGovernanceDaemonStartupLease({
      projectRoot: root,
      pid: 201,
      instanceId: 'first-instance',
      startedAt,
    });
    const second = await acquireGovernanceDaemonStartupLease({
      projectRoot: root,
      pid: 202,
      instanceId: 'second-instance',
      startedAt,
      isProcessAlive: () => false,
      timeoutMs: 50,
      retryMs: 5,
    });

    await expect(first.release()).resolves.toBe(false);
    expect(existsSync(governanceDaemonStartupLeasePath(root))).toBe(true);
    await expect(second.release()).resolves.toBe(true);
    expect(existsSync(governanceDaemonStartupLeasePath(root))).toBe(false);
  });

  it('fails within a bound when a live process holds the lease', async () => {
    const root = projectRoot();
    const first = await acquireGovernanceDaemonStartupLease({
      projectRoot: root,
      pid: 301,
      instanceId: 'first-instance',
      startedAt,
    });

    const attempt = acquireGovernanceDaemonStartupLease({
      projectRoot: root,
      pid: 302,
      instanceId: 'second-instance',
      startedAt,
      isProcessAlive: () => true,
      timeoutMs: 20,
      retryMs: 5,
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(first.release()).resolves.toBe(true);
  });

  it('fails loud and preserves an invalid lease', async () => {
    const root = projectRoot();
    const first = await acquireGovernanceDaemonStartupLease({
      projectRoot: root,
      pid: 401,
      instanceId: 'first-instance',
      startedAt,
    });
    writeFileSync(governanceDaemonStartupLeasePath(root), '{"unexpected":true}\n', 'utf8');

    const attempt = acquireGovernanceDaemonStartupLease({
      projectRoot: root,
      pid: 402,
      instanceId: 'second-instance',
      startedAt,
      isProcessAlive: () => false,
      timeoutMs: 20,
      retryMs: 5,
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'invalid_lease',
    });
    expect(existsSync(governanceDaemonStartupLeasePath(root))).toBe(true);
    await expect(first.release()).resolves.toBe(false);
  });

  it('permits stale endpoint cleanup only on filesystem-socket platforms', () => {
    const stale = { kind: 'stale', metadata: null, metadataState: 'missing' } as const;
    const invalid = {
      kind: 'endpoint_invalid',
      metadata: null,
      reason: 'identity mismatch',
    } as const;

    expect(shouldRecoverGovernanceEndpoint('linux', stale)).toBe(true);
    expect(shouldRecoverGovernanceEndpoint('darwin', stale)).toBe(true);
    expect(shouldRecoverGovernanceEndpoint('win32', stale)).toBe(false);
    expect(shouldRecoverGovernanceEndpoint('linux', invalid)).toBe(false);
  });
});

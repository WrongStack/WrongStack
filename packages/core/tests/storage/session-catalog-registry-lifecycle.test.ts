import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCatalogProjectClient } from '../../src/session-catalog/client.js';
import { sessionCatalogProjectServerMetadataPath } from '../../src/session-catalog/endpoint.js';
import type { SessionLeaseCredential } from '../../src/session-catalog/protocol.js';
import {
  ProjectSessionRegistry,
  type SessionRegistryRegistration,
} from '../../src/session-catalog/registry.js';

const tempRoots: string[] = [];

async function tempGlobalRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-session-registry-'));
  tempRoots.push(root);
  return root;
}

async function writeDiscoveryMetadata(
  globalRoot: string,
  projectSlug: string,
  projectRoot: string,
): Promise<void> {
  const projectDir = path.join(globalRoot, 'projects', projectSlug);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    sessionCatalogProjectServerMetadataPath(projectDir),
    `${JSON.stringify({ projectRoot })}\n`,
  );
}

function registration(projectSlug: string, projectRoot: string): SessionRegistryRegistration {
  return {
    sessionId: `2026-08-09/${projectSlug}`,
    projectSlug,
    projectRoot,
    projectName: projectSlug,
    workingDir: projectRoot,
    clientType: 'tui',
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('ProjectSessionRegistry daemon lifecycle', () => {
  it('probes discovered projects without spawning or retaining cross-project clients', async () => {
    const globalRoot = await tempGlobalRoot();
    await writeDiscoveryMetadata(globalRoot, 'project-a', path.join(globalRoot, 'repo-a'));
    await writeDiscoveryMetadata(globalRoot, 'project-b', path.join(globalRoot, 'repo-b'));

    const spawningCall = vi
      .spyOn(SessionCatalogProjectClient.prototype, 'call')
      .mockRejectedValue(new Error('cross-project discovery attempted a spawning call'));
    const existingCall = vi
      .spyOn(SessionCatalogProjectClient.prototype, 'callExisting')
      .mockResolvedValue([]);
    const close = vi.spyOn(SessionCatalogProjectClient.prototype, 'close').mockResolvedValue();

    const registry = new ProjectSessionRegistry(globalRoot);
    await expect(registry.list()).resolves.toEqual([]);

    expect(spawningCall).not.toHaveBeenCalled();
    expect(existingCall).toHaveBeenCalledTimes(2);
    expect(existingCall).toHaveBeenCalledWith('list_live', {});
    expect(close).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it('does not spawn a daemon when listing a project with no owned session', async () => {
    const globalRoot = await tempGlobalRoot();
    await writeDiscoveryMetadata(globalRoot, 'historical', path.join(globalRoot, 'historical'));

    const spawningCall = vi
      .spyOn(SessionCatalogProjectClient.prototype, 'call')
      .mockRejectedValue(new Error('historical project attempted a spawning call'));
    const existingCall = vi
      .spyOn(SessionCatalogProjectClient.prototype, 'callExisting')
      .mockResolvedValue([]);
    const close = vi.spyOn(SessionCatalogProjectClient.prototype, 'close').mockResolvedValue();

    const registry = new ProjectSessionRegistry(globalRoot);
    await expect(registry.listByProject('historical')).resolves.toEqual([]);

    expect(spawningCall).not.toHaveBeenCalled();
    expect(existingCall).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await registry.dispose();
  });

  it('releases and closes the previous project client after a project switch', async () => {
    const globalRoot = await tempGlobalRoot();
    const credential = (projectSlug: string): SessionLeaseCredential => ({
      sessionId: `2026-08-09/${projectSlug}`,
      leaseId: `lease-${projectSlug}`,
      leaseSecret: `secret-${projectSlug}`,
      ownerInstanceId: 'registry-test',
      expiresAt: Date.now() + 30_000,
    });
    const call = vi
      .spyOn(SessionCatalogProjectClient.prototype, 'call')
      .mockImplementation(async (operation, args) => {
        if (operation === 'claim_new') {
          const entry = (args as { entry: SessionRegistryRegistration }).entry;
          return credential(entry.projectSlug) as never;
        }
        return undefined as never;
      });
    const close = vi.spyOn(SessionCatalogProjectClient.prototype, 'close').mockResolvedValue();

    const registry = new ProjectSessionRegistry(globalRoot);
    await registry.register(registration('project-a', path.join(globalRoot, 'repo-a')));
    await registry.register(registration('project-b', path.join(globalRoot, 'repo-b')));

    expect(call.mock.calls.map(([operation]) => operation)).toEqual([
      'claim_new',
      'claim_new',
      'release',
    ]);
    expect(close).toHaveBeenCalledOnce();

    await registry.dispose();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

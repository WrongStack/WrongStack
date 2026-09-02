import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAtomicWrite = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('@wrongstack/core/utils', () => ({
  atomicWrite: mockAtomicWrite,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

import {
  defaultBaseDir,
  formatInstances,
  isPidAlive,
  joinSessionRegistryWithWebUIInstances,
  listInstances,
  registerInstance,
  registryPath,
  unregisterInstance,
  type WebUIInstanceRecord,
} from '../src/server/instance-registry.js';

describe('instance-registry', () => {
  const sampleRecord: WebUIInstanceRecord = {
    pid: 99999,
    surface: 'webui',
    httpPort: 3456,
    host: '127.0.0.1',
    projectRoot: '/tmp/test-project',
    projectName: 'test-project',
    startedAt: '2024-01-01T00:00:00.000Z',
    url: 'http://127.0.0.1:3456',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('defaultBaseDir', () => {
    it('returns ~/.wrongstack', () => {
      const dir = defaultBaseDir();
      expect(dir).toContain('.wrongstack');
    });
  });

  describe('registryPath', () => {
    it('uses default base dir when not specified', () => {
      const result = registryPath();
      expect(result).toContain('webui-instances.json');
    });

    it('uses provided base dir', () => {
      const result = registryPath('/custom/path');
      expect(result).toContain('webui-instances.json');
      expect(result).toContain('custom');
      expect(result).toContain('path');
    });
  });

  describe('isPidAlive', () => {
    it('returns false for non-integer pid', () => {
      expect(isPidAlive(0)).toBe(false);
      expect(isPidAlive(-1)).toBe(false);
      expect(isPidAlive(1.5)).toBe(false);
    });

    it('returns true when process.kill succeeds', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => undefined as any);
      expect(isPidAlive(1)).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(1, 0);
      killSpy.mockRestore();
    });

    it('returns true on EPERM (process exists, owned by other user)', () => {
      const err = new Error('EPERM') as any;
      err.code = 'EPERM';
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw err;
      });
      expect(isPidAlive(1)).toBe(true);
      killSpy.mockRestore();
    });

    it('returns false on ESRCH (process not found)', () => {
      const err = new Error('ESRCH') as any;
      err.code = 'ESRCH';
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw err;
      });
      expect(isPidAlive(1)).toBe(false);
      killSpy.mockRestore();
    });
  });

  describe('registerInstance', () => {
    it('creates a new registry file entry', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockAtomicWrite.mockResolvedValue(undefined);

      await registerInstance(sampleRecord, '/tmp/base');

      expect(mockAtomicWrite).toHaveBeenCalled();
      const writeCall = mockAtomicWrite.mock.calls.at(-1);
      expect(writeCall).toBeDefined();
      if (!writeCall) throw new Error('Expected registry write');
      const [filePath, content] = writeCall;
      expect(filePath).toContain('webui-instances.json');
      expect(filePath).toContain('base');
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(1);
      expect(parsed.instances).toHaveLength(1);
      expect(parsed.instances[0].pid).toBe(99999);
    });

    it('round-trips optional multi-session child metadata without changing the file version', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockAtomicWrite.mockResolvedValue(undefined);

      await registerInstance(
        {
          ...sampleRecord,
          role: 'session-child',
          sessionId: 'sess-a',
          parentPid: 123,
          parentShellId: 'shell-a',
          runtimeId: 'runtime-a',
          attachable: true,
          auth: { scheme: 'registry-token', tokenPresent: true },
          lastReadyAt: '2026-01-01T00:00:01.000Z',
          protocolVersion: 1,
          capabilities: ['multi-session-child'],
        },
        '/tmp/base',
      );

      const writeCall = mockAtomicWrite.mock.calls.at(-1);
      expect(writeCall).toBeDefined();
      if (!writeCall) throw new Error('Expected registry write');
      const [, content] = writeCall;
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(1);
      expect(parsed.instances[0]).toMatchObject({
        role: 'session-child',
        sessionId: 'sess-a',
        parentPid: 123,
        parentShellId: 'shell-a',
        runtimeId: 'runtime-a',
        attachable: true,
        auth: { scheme: 'registry-token', tokenPresent: true },
        lastReadyAt: '2026-01-01T00:00:01.000Z',
        protocolVersion: 1,
        capabilities: ['multi-session-child'],
      });
    });
  });

  describe('unregisterInstance', () => {
    it('removes the instance from registry', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          instances: [sampleRecord],
        }),
      );
      mockAtomicWrite.mockResolvedValue(undefined);

      await unregisterInstance(99999, '/tmp/base');

      expect(mockAtomicWrite).toHaveBeenCalled();
      const writeCall = mockAtomicWrite.mock.calls.at(-1);
      expect(writeCall).toBeDefined();
      if (!writeCall) throw new Error('Expected registry write');
      const [, content] = writeCall;
      const parsed = JSON.parse(content);
      expect(parsed.instances).toHaveLength(0);
    });

    it('handles missing file gracefully', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockAtomicWrite.mockResolvedValue(undefined);

      await unregisterInstance(99999, '/tmp/base');

      expect(mockAtomicWrite).toHaveBeenCalled();
    });

    it('handles corrupt file gracefully', async () => {
      mockReadFile.mockResolvedValue('not json');
      mockAtomicWrite.mockResolvedValue(undefined);

      await unregisterInstance(99999, '/tmp/base');
      expect(mockAtomicWrite).toHaveBeenCalled();
    });
  });

  describe('listInstances', () => {
    it('returns live instances list', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => undefined as any);

      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          instances: [sampleRecord],
        }),
      );
      mockAtomicWrite.mockResolvedValue(undefined);

      const instances = await listInstances('/tmp/base');

      expect(instances).toHaveLength(1);
      expect(instances[0].pid).toBe(99999);
      killSpy.mockRestore();
    });

    it('handles missing file', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      const instances = await listInstances('/tmp/base');
      expect(instances).toEqual([]);
    });

    it('prunes dead entries and persists', async () => {
      const err = new Error('ESRCH') as any;
      err.code = 'ESRCH';
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw err;
      });

      const deadRecord = { ...sampleRecord, pid: 11111 };
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          instances: [deadRecord],
        }),
      );
      mockAtomicWrite.mockResolvedValue(undefined);

      const instances = await listInstances('/tmp/base');

      expect(instances).toHaveLength(0);
      expect(mockAtomicWrite).toHaveBeenCalled(); // pruned view persisted
      killSpy.mockRestore();
    });
  });

  describe('formatInstances', () => {
    it('returns "no instances" message when empty', () => {
      const result = formatInstances([]);
      expect(result).toContain('No WebUI instances');
    });

    it('formats instance list', () => {
      const result = formatInstances([sampleRecord]);
      expect(result).toContain('1');
      expect(result).toContain('3456');
      expect(result).toContain('test-project');
    });
  });

  describe('joinSessionRegistryWithWebUIInstances', () => {
    const session = {
      sessionId: 'sess-a',
      projectSlug: 'proj',
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      workingDir: '/tmp/test-project/src',
      clientType: 'webui',
      status: 'active' as const,
      pid: 99999,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastHeartbeatAt: '2026-01-01T00:00:01.000Z',
      agentCount: 0,
      agents: [],
    };

    const childInstance: WebUIInstanceRecord = {
      ...sampleRecord,
      role: 'session-child',
      sessionId: 'sess-a',
      attachable: true,
      authToken: 'token-a',
    };

    it('marks matching live session-child endpoints attachable', () => {
      const candidates = joinSessionRegistryWithWebUIInstances({
        sessions: [session],
        instances: [childInstance],
        projectSlug: 'proj',
      });

      expect(candidates).toEqual([
        expect.objectContaining({
          sessionId: 'sess-a',
          attachable: true,
          endpoint: {
            host: '127.0.0.1',
            httpPort: 3456,
            url: 'http://127.0.0.1:3456',
            authToken: 'token-a',
          },
        }),
      ]);
    });

    it('reports live sessions without WebUI endpoints as degraded', () => {
      const candidates = joinSessionRegistryWithWebUIInstances({
        sessions: [session],
        instances: [],
      });

      expect(candidates).toEqual([
        expect.objectContaining({
          sessionId: 'sess-a',
          attachable: false,
          degradedReason: 'live-session-no-webui-endpoint',
        }),
      ]);
    });

    it('reports non-live sessions as degraded even when an endpoint exists', () => {
      const candidates = joinSessionRegistryWithWebUIInstances({
        sessions: [{ ...session, status: 'closing' }],
        instances: [childInstance],
      });

      expect(candidates[0]).toMatchObject({
        attachable: false,
        degradedReason: 'session-not-live',
      });
    });

    it('reports owner mismatches when endpoint and session PIDs differ', () => {
      const candidates = joinSessionRegistryWithWebUIInstances({
        sessions: [session],
        instances: [{ ...childInstance, pid: 11111 }],
      });

      expect(candidates[0]).toMatchObject({
        attachable: false,
        degradedReason: 'endpoint-owner-mismatch',
      });
    });

    it('reports endpoints missing session ids as degraded', () => {
      const { sessionId: _sessionId, ...instanceWithoutSessionId } = childInstance;
      const candidates = joinSessionRegistryWithWebUIInstances({
        sessions: [session],
        instances: [instanceWithoutSessionId],
      });

      expect(candidates[0]).toMatchObject({
        attachable: false,
        degradedReason: 'endpoint-missing-session-id',
      });
    });

    it('does not attach an endpoint whose explicit session id mismatches the registry session', () => {
      const candidates = joinSessionRegistryWithWebUIInstances({
        sessions: [session],
        instances: [{ ...childInstance, sessionId: 'sess-other' }],
      });

      expect(candidates[0]).toMatchObject({
        attachable: false,
        degradedReason: 'endpoint-session-mismatch',
      });
    });

    it('reports non-child or explicitly non-attachable endpoints as degraded', () => {
      expect(
        joinSessionRegistryWithWebUIInstances({
          sessions: [session],
          instances: [{ ...childInstance, role: 'standalone' }],
        })[0],
      ).toMatchObject({ attachable: false, degradedReason: 'endpoint-not-session-child' });

      expect(
        joinSessionRegistryWithWebUIInstances({
          sessions: [session],
          instances: [{ ...childInstance, attachable: false }],
        })[0],
      ).toMatchObject({ attachable: false, degradedReason: 'endpoint-not-attachable' });
    });

    it('filters candidates by project slug and root when requested', () => {
      const candidates = joinSessionRegistryWithWebUIInstances({
        sessions: [session, { ...session, sessionId: 'sess-b', projectSlug: 'other' }],
        instances: [childInstance],
        projectSlug: 'proj',
        projectRoot: '/tmp/test-project',
      });

      expect(candidates.map((candidate) => candidate.sessionId)).toEqual(['sess-a']);
    });
  });
});

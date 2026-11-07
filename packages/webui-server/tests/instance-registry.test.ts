import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAtomicWrite = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('@wrongstack/core/utils', () => ({
  atomicWrite: mockAtomicWrite,
  withFileLock: (_file: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

import {
  defaultBaseDir,
  formatInstances,
  isPidAlive,
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
      expect(parsed.instances[0]!.pid).toBe(99999);
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

    it('refuses to rewrite a registry it could not read', async () => {
      mockReadFile.mockRejectedValue({ code: 'EBUSY' });
      await expect(registerInstance(sampleRecord, '/tmp/test-base')).rejects.toMatchObject({
        code: 'EBUSY',
      });
      expect(mockAtomicWrite).not.toHaveBeenCalled();
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
      expect(instances[0]!.pid).toBe(99999);
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

  describe('registerInstance merge', () => {
    // B-07: migrated from packages/webui/tests/server/instance-registry.test.ts
    // — a SECOND registerInstance for the same pid must REPLACE the existing
    // entry, not append. Without this pin a future refactor that switches to
    // a push-only strategy (or forgets the merge step) would silently leak
    // dead entries every time a session rebinds.
    it('replaces a stale entry for the same pid instead of duplicating', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => undefined as any);
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockAtomicWrite.mockResolvedValue(undefined);

      await registerInstance({ ...sampleRecord, httpPort: 3456 }, '/tmp/base');
      await registerInstance({ ...sampleRecord, httpPort: 9999 }, '/tmp/base');

      const lastWrite = mockAtomicWrite.mock.calls.at(-1);
      expect(lastWrite).toBeDefined();
      if (!lastWrite) throw new Error('Expected registry write');
      const [, content] = lastWrite;
      const parsed = JSON.parse(content);
      expect(parsed.instances).toHaveLength(1);
      expect(parsed.instances[0].httpPort).toBe(9999);
      killSpy.mockRestore();
    });

    // B-07: migrated from packages/webui/tests/server/instance-registry.test.ts
    // — registerInstance must drop a pre-existing DEAD-pid entry in the same
    // file before writing the live one. The server's existing `'prunes dead
    // entries and persists'` only exercises listInstances; this covers the
    // symmetric registerInstance path so a refactor that splits the prune
    // logic between register and list cannot regress only one direction.
    it('prunes dead-pid entries on register', async () => {
      const err = new Error('ESRCH') as any;
      err.code = 'ESRCH';
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
        if (pid === 11111) throw err;
        return undefined as any;
      });

      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          instances: [{ ...sampleRecord, pid: 11111, projectName: 'ghost' }],
        }),
      );
      mockAtomicWrite.mockResolvedValue(undefined);

      await registerInstance({ ...sampleRecord, projectName: 'live' }, '/tmp/base');

      const lastWrite = mockAtomicWrite.mock.calls.at(-1);
      expect(lastWrite).toBeDefined();
      if (!lastWrite) throw new Error('Expected registry write');
      const [, content] = lastWrite;
      const parsed = JSON.parse(content);
      expect(parsed.instances).toHaveLength(1);
      expect(parsed.instances[0].projectName).toBe('live');
      killSpy.mockRestore();
    });
  });
});

import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ensureDistDir,
  findInstalledPackageJson,
  resolveDistDir,
  startStaticServe,
} from '../src/server/frontend-static-serve.js';

describe('frontend-static-serve', () => {
  describe('findInstalledPackageJson', () => {
    it('returns undefined for non-existent package', () => {
      const result = findInstalledPackageJson('non-existent-package-xyz-123');
      expect(result).toBeUndefined();
    });

    it('returns package.json path for installed package', () => {
      const result = findInstalledPackageJson('vitest');
      expect(result).toBeDefined();
      expect(result).toContain('package.json');
    });

    it('handles empty package specifier', () => {
      expect(findInstalledPackageJson('')).toBeUndefined();
    });
  });

  describe('resolveDistDir', () => {
    it('resolves explicit dist directory', () => {
      const result = resolveDistDir('/custom/dist');
      expect(result).toBeDefined();
      expect(result).toContain('dist');
    });

    it('resolves explicitDistDir in options', () => {
      const result = resolveDistDir({ explicitDistDir: 'custom/relative/dist' });
      expect(result).toBeDefined();
    });

    it('returns null when index.html does not exist', () => {
      const result = resolveDistDir({
        resolvePackageJson: () => '/fake/package.json',
        exists: () => false,
      });
      expect(result).toBeNull();
    });

    it('returns distDir when index.html exists', () => {
      const result = resolveDistDir({
        resolvePackageJson: () => '/fake/package.json',
        exists: (p) => p.includes('index.html'),
      });
      expect(result).toBe(path.join('/fake', 'dist'));
    });

    it('throws when custom resolvePackageJson throws', () => {
      expect(() =>
        resolveDistDir({
          resolvePackageJson: () => {
            throw new Error('failed');
          },
        }),
      ).toThrow('@wrongstack/webui package could not be resolved');
    });
  });

  describe('ensureDistDir', () => {
    it('returns explicit dist dir if index.html exists', async () => {
      const result = await ensureDistDir('/custom/dist', {
        exists: () => true,
      });
      expect(result).toContain('dist');
    });

    it('returns null for explicit dist dir if index.html is missing', async () => {
      const result = await ensureDistDir('/custom/dist', {
        exists: () => false,
      });
      expect(result).toBeNull();
    });

    it('returns existing distDir if already built', async () => {
      const result = await ensureDistDir(undefined, {
        resolvePackageJson: () => '/fake/package.json',
        exists: () => true,
      });
      expect(result).toBe(path.join('/fake', 'dist'));
    });

    it('throws error when not inside pnpm workspace', async () => {
      await expect(
        ensureDistDir(undefined, {
          resolvePackageJson: () => '/fake/package.json',
          exists: () => false,
          findWorkspaceRoot: () => null,
        }),
      ).rejects.toThrow('is not inside a pnpm workspace');
    });

    it('handles build error gracefully', async () => {
      await expect(
        ensureDistDir(undefined, {
          resolvePackageJson: () => '/fake/package.json',
          exists: () => false,
          findWorkspaceRoot: () => '/fake/workspace',
          runBuild: () => {
            throw new Error('spawn failed');
          },
        }),
      ).rejects.toThrow('webui.auto_build.failed: spawn failed');
    });

    it('throws if dist still missing after successful build', async () => {
      await expect(
        ensureDistDir(undefined, {
          resolvePackageJson: () => '/fake/package.json',
          exists: () => false,
          findWorkspaceRoot: () => '/fake/workspace',
          runBuild: () => {},
        }),
      ).rejects.toThrow('frontend is not built');
    });

    it('succeeds if dist appears after build', async () => {
      let built = false;
      const result = await ensureDistDir(undefined, {
        resolvePackageJson: () => '/fake/package.json',
        exists: () => built,
        findWorkspaceRoot: () => '/fake/workspace',
        runBuild: () => {
          built = true;
        },
      });
      expect(result).toBe(path.join('/fake', 'dist'));
    });
  });

  describe('startStaticServe', () => {
    function makeMockServer(): Server {
      const emitter = new EventEmitter() as Server;
      emitter.listen = vi.fn((_port, _host, cb) => {
        cb?.();
        process.nextTick(() => emitter.emit('listening'));
        return emitter;
      });
      emitter.close = vi.fn((cb) => {
        cb?.();
        return emitter;
      });
      (emitter as unknown as { address: () => { port: number } }).address = () => ({ port: 3005 });
      return emitter;
    }

    it('returns null when distDir cannot be resolved', async () => {
      const result = await startStaticServe(
        {
          host: '127.0.0.1',
          httpPort: 3000,
          globalRoot: '/global',
        },
        {
          resolveDist: () => null,
        },
      );
      expect(result).toBeNull();
    });

    it('starts server with deferListen: true', async () => {
      const mockServer = makeMockServer();
      const result = await startStaticServe(
        {
          host: '127.0.0.1',
          httpPort: 3000,
          globalRoot: '/global',
          deferListen: true,
          projectRoot: '/project',
          getLlm: vi.fn(),
          onFleetPing: vi.fn(),
          onTechStackEvent: vi.fn(),
          apiToken: 'secret',
          requireToken: true,
          allowedHostnames: ['localhost'],
          vectorMemoryModelCacheDir: '/models',
          getVectorMemoryStore: vi.fn(),
        },
        {
          resolveDist: () => '/dist',
          createServer: () => mockServer,
        },
      );
      expect(result).not.toBeNull();
      expect(result?.port).toBe(3000);
      expect(result?.server).toBe(mockServer);
    });

    it('starts server and listens when deferListen is false', async () => {
      const mockServer = makeMockServer();
      const result = await startStaticServe(
        {
          host: '127.0.0.1',
          httpPort: 3005,
          globalRoot: '/global',
          strictPort: true,
        },
        {
          resolveDist: () => '/dist',
          createServer: () => mockServer,
        },
      );
      expect(result).not.toBeNull();
      expect(result?.server).toBe(mockServer);
    });
  });
});

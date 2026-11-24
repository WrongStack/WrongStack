import type * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureDistDir,
  findInstalledPackageJson,
  resolveDistDir,
  startStaticServe,
} from '../src/server/frontend-static-serve.js';

// `spawn` is the process boundary of `ensureDistDir`'s default build runner.
// It passes through to the real implementation unless a test puts a simulated
// machine behind it, so the rest of this file is unaffected.
const processBoundary = vi.hoisted(() => ({
  spawn: vi.fn(),
  real: undefined as unknown as typeof childProcess.spawn,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  processBoundary.real = actual.spawn;
  processBoundary.spawn.mockImplementation(actual.spawn);
  return { ...actual, spawn: processBoundary.spawn };
});

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

    // Regression cover for the 404/WS-only degradation: a sibling workspace
    // package is not a declared dependency, so Node resolution throws and the
    // lookup used to return undefined with no diagnostic.
    describe('pnpm workspace fallback', () => {
      // Synthetic name so the assertions can never be satisfied by a real
      // global/standalone install of the package under test.
      const PKG = '@wrongstack/ws-dist-fixture-abc';
      const DIR = 'ws-dist-fixture-abc';
      let root: string;

      const writeSibling = (manifestName: string): string => {
        const dir = path.join(root, 'packages', DIR);
        mkdirSync(dir, { recursive: true });
        const manifest = path.join(dir, 'package.json');
        writeFileSync(manifest, JSON.stringify({ name: manifestName, version: '0.0.0' }));
        return manifest;
      };

      // Lives inside the workspace but is NOT the package we ask for.
      const hostEntry = (): string => path.join(root, 'packages', 'host', 'dist', 'entry.js');

      beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), 'ws-dist-fixture-'));
        writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      });

      afterEach(() => {
        rmSync(root, { recursive: true, force: true });
      });

      it('resolves a workspace sibling when the specifier is not a dependency', () => {
        const expected = writeSibling(PKG);
        expect(findInstalledPackageJson(PKG, hostEntry())).toBe(expected);
      });

      it('resolves the same sibling from a file: URL base', () => {
        const expected = writeSibling(PKG);
        expect(findInstalledPackageJson(PKG, pathToFileURL(hostEntry()).href)).toBe(expected);
      });

      it('rejects a sibling directory whose manifest declares another name', () => {
        writeSibling('@wrongstack/some-other-package');
        expect(findInstalledPackageJson(PKG, hostEntry())).toBeUndefined();
      });

      it('returns undefined outside any pnpm workspace', () => {
        writeSibling(PKG);
        const bare = mkdtempSync(path.join(tmpdir(), 'ws-dist-bare-'));
        try {
          rmSync(path.join(bare, 'pnpm-workspace.yaml'), { force: true });
          expect(
            findInstalledPackageJson(PKG, path.join(bare, 'dist', 'entry.js')),
          ).toBeUndefined();
        } finally {
          rmSync(bare, { recursive: true, force: true });
        }
      });

      it('prefers a real installed dependency over the workspace sibling', () => {
        const sibling = writeSibling(PKG);
        const installed = path.join(root, 'node_modules', '@wrongstack', DIR);
        mkdirSync(installed, { recursive: true });
        writeFileSync(
          path.join(installed, 'package.json'),
          JSON.stringify({ name: PKG, version: '0.0.0', main: 'index.js' }),
        );
        writeFileSync(path.join(installed, 'index.js'), 'module.exports = {};');
        // Same tree, so a directory-name match would be ambiguous on purpose.
        expect(findInstalledPackageJson(PKG, hostEntry())).not.toBe(sibling);
        expect(findInstalledPackageJson(PKG, hostEntry())).toBe(
          path.join(installed, 'package.json'),
        );
      });
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

    // The cases above inject `runBuild`; production uses the default runner.
    // It spawned `pnpm`, which pnpm 10+ refuses in a repository whose
    // `packageManager` is bun and a Bun-only machine does not have, so the
    // cold-start recovery failed on every default setup.
    describe('default build runner', () => {
      const workspace = path.resolve(path.sep, 'workspace');
      const webui = path.join(workspace, 'packages', 'webui');
      /** The remedy the error messages name; it is also the command that runs. */
      const remedy = 'bun run --filter @wrongstack/webui build';

      interface SpawnCall {
        command: string;
        args: readonly string[];
        cwd: string | undefined;
      }

      /** A simulated machine: what is on PATH, and which executable refuses this repository. */
      interface Machine {
        name: string;
        installed: readonly string[];
        refusing: readonly string[] | undefined;
        /** How an absent executable fails: ENOENT on POSIX, exit 1 through cmd.exe. */
        absentFails: 'error' | 'close';
      }

      /** Put a simulated machine behind the process boundary and return what it spawned. */
      function simulate(machine: Machine): { calls: SpawnCall[]; failBuilds: () => void } {
        const calls: SpawnCall[] = [];
        let exitCode = 0;
        processBoundary.spawn.mockImplementation(((
          command: string,
          args: readonly string[],
          options?: { cwd?: string },
        ) => {
          calls.push({ command, args, cwd: options?.cwd });
          const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
          child.kill = () => false;
          process.nextTick(() => {
            if (!machine.installed.includes(command)) {
              if (machine.absentFails === 'error') {
                child.emit(
                  'error',
                  Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }),
                );
              } else {
                child.emit('close', 1);
              }
            } else if (machine.refusing?.includes(command)) {
              child.emit('close', 1);
            } else {
              child.emit('close', exitCode);
            }
          });
          return child;
        }) as unknown as typeof childProcess.spawn);
        return {
          calls,
          failBuilds: () => {
            exitCode = 1;
          },
        };
      }

      const missingDist = {
        resolvePackageJson: () => path.join(webui, 'package.json'),
        findWorkspaceRoot: () => workspace,
      };

      const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
        promise.then(
          () => undefined,
          (error: unknown) => error,
        );

      afterEach(() => {
        processBoundary.spawn.mockImplementation(processBoundary.real);
      });

      it.each([
        {
          name: 'pnpm 10+ beside bun, which refuses the repository',
          installed: ['pnpm', 'bun'],
          refusing: ['pnpm'],
          absentFails: 'error',
        },
        {
          name: 'a Bun-only POSIX machine',
          installed: ['bun'],
          refusing: undefined,
          absentFails: 'error',
        },
        {
          name: 'a Bun-only Windows machine',
          installed: ['bun'],
          refusing: undefined,
          absentFails: 'close',
        },
      ] satisfies Machine[])('recovers a missing dist through bun on $name', async (machine) => {
        const { calls } = simulate(machine);
        // The dist exists once a build has been spawned.
        const result = await ensureDistDir(undefined, {
          ...missingDist,
          exists: () => calls.length > 0,
        });
        expect(result).toBe(path.join(webui, 'dist'));
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call && `${call.command} ${call.args.join(' ')}`).toBe(remedy);
        expect(call?.cwd).toBe(workspace);
      });

      it('spawns nothing for an already-built dist', async () => {
        const { calls } = simulate({
          name: 'bun',
          installed: ['bun'],
          refusing: undefined,
          absentFails: 'error',
        });
        await expect(
          ensureDistDir(undefined, { ...missingDist, exists: () => true }),
        ).resolves.toBe(path.join(webui, 'dist'));
        expect(calls).toHaveLength(0);
      });

      it('names the Bun remedy when the build fails', async () => {
        const { failBuilds } = simulate({
          name: 'bun',
          installed: ['bun'],
          refusing: undefined,
          absentFails: 'error',
        });
        failBuilds();
        const failure = await failureOf(
          ensureDistDir(undefined, { ...missingDist, exists: () => false }),
        );
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain('webui.auto_build.failed');
        expect(String(failure)).toContain(remedy);
        expect(String(failure)).not.toContain('pnpm');
      });

      it('names the same remedy when Bun itself is missing', async () => {
        simulate({
          name: 'no build tool',
          installed: [],
          refusing: undefined,
          absentFails: 'error',
        });
        const failure = await failureOf(
          ensureDistDir(undefined, { ...missingDist, exists: () => false }),
        );
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain('webui.auto_build.failed: spawn bun ENOENT');
        expect(String(failure)).toContain(remedy);
      });
    });
  });

  describe('startStaticServe', () => {
    function makeMockServer(): Server {
      const emitter = new EventEmitter() as Server;
      emitter.listen = vi.fn((...args: unknown[]) => {
        const cb = args.find((arg): arg is () => void => typeof arg === 'function');
        cb?.();
        process.nextTick(() => emitter.emit('listening'));
        return emitter;
      }) as unknown as Server['listen'];
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

    // The silent-degradation guard: a null dist used to return with no log at
    // all, so an operator saw a WebUI that simply had no pages and the only
    // clue was a bare "Not found" body.
    it('warns with the remedy when the frontend cannot be resolved', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await startStaticServe(
          { host: '127.0.0.1', httpPort: 3000, globalRoot: '/global' },
          { resolveDist: () => null },
        );
        const line = warn.mock.calls
          .map(([l]) => String(l))
          .find((l) => l.includes('frontend_unavailable'));
        expect(line).toBeDefined();
        const parsed = JSON.parse(String(line));
        expect(parsed).toMatchObject({ level: 'warn', event: 'webui.frontend_unavailable' });
        // The message must name the consequence AND the fix.
        expect(parsed.message).toMatch(/WebSocket only/i);
        expect(parsed.message).toMatch(/404/);
        expect(parsed.message).toContain('bun run --filter @wrongstack/webui build');
      } finally {
        warn.mockRestore();
      }
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

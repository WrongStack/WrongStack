import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The provisioned version matches the package's Playwright development dependency.
const PLAYWRIGHT_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    devDependencies: Record<string, string>;
  }
).devDependencies['@playwright/test']?.replace(/^\^/, '');

describe('standalone binary browser provisioning', () => {
  it.each([false, true])(
    'provisions a missing package and browser (embedded Bun: %s)',
    (embeddedBun) => {
      const root = mkdtempSync(join(tmpdir(), 'browser-package-'));
      try {
        const dir = join(root, 'isolated');
        mkdirSync(dir);
        const stub = join(dir, 'installer.mjs');
        writeFileSync(
          stub,
          `
        import { EventEmitter } from 'node:events';
        import { existsSync as exists, mkdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        export const homedir = () => ${JSON.stringify(root)};
        export const existsSync = path => path.endsWith('npm-cli.js') || exists(path);
        export const calls = [];
        export function buildChildEnv(opts) {
          return { ...process.env, ...(opts && opts.extra ? opts.extra : {}) };
        }
        export function toErrorMessage(error) {
          return error instanceof Error ? error.message : String(error);
        }
        export function spawn(runtime, args) {
          calls.push(args);
          const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
          queueMicrotask(() => {
            if (args.includes('--prefix') || args.includes('--cwd')) {
              const flag = args.includes('--prefix') ? '--prefix' : '--cwd';
              const cache = args[args.indexOf(flag) + 1];
              const test = join(cache, 'node_modules', '@playwright', 'test');
              const pw = join(cache, 'node_modules', 'playwright');
              mkdirSync(test, { recursive: true }); mkdirSync(pw, { recursive: true });
              writeFileSync(join(test, 'package.json'), JSON.stringify({ name: '@playwright/test', type: 'module', main: 'index.js' }));
              writeFileSync(join(test, 'index.js'), 'export const chromium = { executablePath: () => ' + JSON.stringify(join(homedir(), 'chromium')) + ', launch: async () => ({ fixture: true }) };');
              writeFileSync(join(pw, 'package.json'), JSON.stringify({ name: 'playwright' }));
              writeFileSync(join(pw, 'cli.js'), '');
            } else writeFileSync(join(homedir(), 'chromium'), 'fixture');
            child.emit('close', 0, null);
          });
          return child;
        }
      `,
        );
        // A real Node importer outside the workspace has no Playwright package.
        // Replace only process/download dependencies; keep module resolution real.
        const stubHref = JSON.stringify(pathToFileURL(stub).href);
        const source = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8')
          .replace("'node:child_process'", stubHref)
          .replace("'node:os'", stubHref)
          .replace("'node:fs'", stubHref)
          .replace("'@wrongstack/core/utils'", stubHref)
          .replace("'@wrongstack/core/utils/error'", stubHref);
        writeFileSync(
          join(dir, 'runtime.mjs'),
          transformSync(source, { loader: 'ts', format: 'esm' }).code,
        );
        writeFileSync(
          join(dir, 'probe.mjs'),
          `
        ${embeddedBun ? "Object.defineProperty(process.versions, 'bun', { value: 'fixture' });" : ''}
        const { loadPlaywrightRuntime, launchBrowserRuntime } = await import('./runtime.mjs');
        import { calls } from './installer.mjs';
        let missing = false;
        try { await loadPlaywrightRuntime(false); } catch { missing = true; }
        if (!missing || calls.length) throw new Error('Diagnostics unexpectedly installed a package');
        const browsers = await Promise.all([launchBrowserRuntime(true), launchBrowserRuntime(true)]);
        console.log(JSON.stringify({ browsers, calls }));
      `,
        );
        const result = spawnSync(process.execPath, [join(dir, 'probe.mjs')], {
          encoding: 'utf8',
          timeout: 10_000,
          // Vitest puts the workspace store on NODE_PATH, so a bare
          // import('@playwright/test') from the temp file would resolve the
          // installed package and skip the missing-package path.
          env: { ...process.env, NODE_PATH: '' },
        });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.browsers).toEqual([{ fixture: true }, { fixture: true }]);
        expect(output.calls).toHaveLength(2);
        expect(output.calls[0]).toEqual(
          expect.arrayContaining(['--ignore-scripts', `@playwright/test@${PLAYWRIGHT_VERSION}`]),
        );
        expect(output.calls[1]).toEqual([expect.stringMatching(/cli\.js$/), 'install', 'chromium']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

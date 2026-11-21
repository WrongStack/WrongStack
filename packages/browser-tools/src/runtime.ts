import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from '@playwright/test';
import { buildChildEnv } from '@wrongstack/core/utils';
import { toErrorMessage } from '@wrongstack/core/utils/error';

let installation: Promise<void> | undefined;
type PlaywrightRuntime = Pick<typeof import('@playwright/test'), 'chromium'>;
let moduleSetup: Promise<PlaywrightRuntime> | undefined;
let runtimeRequire = createRequire(import.meta.url);
// Kept aligned with the tools package dependency by browser-runtime.test.ts.
const PLAYWRIGHT_VERSION = '1.65.1';

function javascriptRuntime(): string {
  if (process.versions['bun']) return process.execPath;
  return /^(?:node|bun)(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : 'node';
}

function runInstaller(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = '';
    const child = spawn(javascriptRuntime(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 180_000,
      // npm/bun need PATH and the user cache, not provider keys.
      env: buildChildEnv(process.versions['bun'] ? { extra: { BUN_BE_BUN: '1' } } : undefined),
    });
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`Browser runtime installation failed (${signal ?? code}): ${output.trim()}`),
        );
    });
  });
}

/** Binaries externalize Playwright. Provision it in a versioned user cache. */
export async function loadPlaywrightRuntime(provision = true): Promise<PlaywrightRuntime> {
  if (!moduleSetup) {
    moduleSetup = (async () => {
      try {
        return await import('@playwright/test');
      } catch (error) {
        if (
          !['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
      }
      const cache = join(homedir(), '.wrongstack', 'runtime', 'playwright', PLAYWRIGHT_VERSION);
      const cachedRequire = createRequire(join(cache, 'package.json'));
      let modulePath: string;
      try {
        modulePath = cachedRequire.resolve('@playwright/test');
      } catch (error) {
        if (!provision) throw error;
        if (process.versions['bun']) {
          await mkdir(cache, { recursive: true });
          // Keep the cache a standalone package; never let package-manager
          // workspace discovery reach a parent or the user's current project.
          await writeFile(join(cache, 'package.json'), JSON.stringify({ private: true }));
          await runInstaller([
            'add',
            '--cwd',
            cache,
            '--ignore-scripts',
            '--no-save',
            `@playwright/test@${PLAYWRIGHT_VERSION}`,
          ]);
        } else {
          const roots = [
            dirname(process.execPath),
            ...(process.env['PATH'] ?? '').split(delimiter),
          ];
          const npmCli = [
            ...roots.map((root) => join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
            '/usr/share/nodejs/npm/bin/npm-cli.js',
            '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
          ].find((candidate) => existsSync(candidate));
          if (!npmCli)
            throw new Error('Automatic Playwright setup needs Node.js with npm available on PATH.');
          await runInstaller([
            npmCli,
            'install',
            '--prefix',
            cache,
            '--no-audit',
            '--no-fund',
            '--ignore-scripts',
            `@playwright/test@${PLAYWRIGHT_VERSION}`,
          ]);
        }
        modulePath = cachedRequire.resolve('@playwright/test');
      }
      runtimeRequire = cachedRequire;
      return (await import(pathToFileURL(modulePath).href)) as PlaywrightRuntime;
    })().catch((error: unknown) => {
      moduleSetup = undefined;
      throw error;
    });
  }
  return moduleSetup;
}

/** Install the revision belonging to our own Playwright, without npx or a shell. */
export async function installBrowserRuntime(): Promise<void> {
  if (!installation) {
    installation = installChromium().finally(() => {
      installation = undefined;
    });
  }
  return installation;
}

async function installChromium(): Promise<void> {
  await loadPlaywrightRuntime();
  const packageRequire = createRequire(runtimeRequire.resolve('@playwright/test/package.json'));
  const cli = join(dirname(packageRequire.resolve('playwright/package.json')), 'cli.js');
  await access(cli);
  await runInstaller([cli, 'install', 'chromium']);
}

export async function launchBrowserRuntime(headless: boolean): Promise<Browser> {
  try {
    const { chromium } = await loadPlaywrightRuntime();
    // Repair missing executables before launch. Launch failures such as missing
    // Linux libraries are not repaired by downloading the same browser again.
    try {
      await access(chromium.executablePath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await installBrowserRuntime();
    }
    return await chromium.launch({ headless });
  } catch (error) {
    throw new Error(`browser: Chromium setup/launch failed: ${toErrorMessage(error)}`, {
      cause: error,
    });
  }
}

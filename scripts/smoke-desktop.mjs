#!/usr/bin/env bun
// Exercise the packaged dependency closure using Electron's own Node runtime.
// --window additionally checks application startup. All checks use a scratch
// profile, so they do not access the user's WrongStack settings or sessions.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DESKTOP_PACKAGE_STAGE_RELATIVE } from './desktop-package-paths.mjs';

const output = resolve(DESKTOP_PACKAGE_STAGE_RELATIVE, 'release');
const defaultExecutable =
  process.platform === 'win32'
    ? join(output, 'win-unpacked', 'WrongStack.exe')
    : process.platform === 'darwin'
      ? join(
          output,
          process.arch === 'arm64' ? 'mac-arm64' : 'mac',
          'WrongStack.app',
          'Contents',
          'MacOS',
          'WrongStack',
        )
      : join(output, 'linux-unpacked', 'wrongstack-desktop');
const windowSmoke = process.argv.includes('--window');
const executable = resolve(
  process.argv.slice(2).find((arg) => arg !== '--window') || defaultExecutable,
);
const resources =
  process.platform === 'darwin'
    ? resolve(dirname(executable), '..', 'Resources')
    : join(dirname(executable), 'resources');
const scratch = mkdtempSync(join(tmpdir(), 'wrongstack-desktop-smoke-'));
const probe = String.raw`
  import { pathToFileURL, fileURLToPath } from 'node:url';
  import { createRequire } from 'node:module';
  import { existsSync, readFileSync } from 'node:fs';
  import { join, dirname } from 'node:path';
  const root = join(process.env.DESKTOP_SMOKE_RESOURCES, 'app.asar');
  const resolveModule = name => import.meta.resolve(name, pathToFileURL(join(root, 'package.json')).href);
  (async () => {
    for (const file of ['dist/main/main.js', 'dist/preload/preload.cjs', 'dist/preload/webui-preload.cjs', 'dist/renderer/index.html']) {
      if (!existsSync(join(root, file))) throw new Error('Missing packaged asset: ' + file);
    }
    const renderer = join(root, 'dist', 'renderer');
    const html = readFileSync(join(renderer, 'index.html'), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="(\.\/assets\/[^" ]+)"/g)) {
      if (!existsSync(join(renderer, match[1]))) throw new Error('Missing renderer dependency: ' + match[1]);
    }
    for (const name of ['@wrongstack/core/utils', '@wrongstack/core/storage', '@wrongstack/webui-protocol', '@wrongstack/webui-server']) {
      await import(resolveModule(name));
    }
    const webui = dirname(fileURLToPath(resolveModule('@wrongstack/webui')));
    if (!existsSync(join(webui, 'index.html'))) throw new Error('Missing packaged WebUI HTML');
    const server = fileURLToPath(resolveModule('@wrongstack/webui-server'));
    if (!existsSync(join(dirname(server), 'server', 'entry.js'))) throw new Error('Missing packaged server entry');
    const pty = createRequire(server)('node-pty');
    await new Promise((resolve, reject) => {
      const marker = 'WRONGSTACK_DESKTOP_PTY_OK';
      const terminal = pty.spawn(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
        process.platform === 'win32' ? ['/d', '/c', 'echo ' + marker] : ['-c', 'printf ' + marker],
        { cwd: process.cwd(), env: process.env, cols: 80, rows: 24 });
      let output = '';
      const timer = setTimeout(() => { terminal.kill(); reject(new Error('Packaged PTY timed out')); }, 10000);
      terminal.onData(data => { output += data; });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode === 0 && output.includes(marker)) resolve();
        else reject(new Error('Packaged PTY failed: ' + exitCode + ' ' + output));
      });
    });
    console.log('Desktop packaged PTY OK');
    console.log('Desktop packaged dependencies and assets OK');
    process.exit(0);
  })().catch(error => { console.error(error); process.exit(1); });
`;
try {
  execFileSync(
    executable,
    ['--experimental-import-meta-resolve', '--input-type=module', '-e', probe],
    {
      cwd: scratch,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WRONGSTACK_HOME: scratch,
        DESKTOP_SMOKE_RESOURCES: resources,
      },
      stdio: 'inherit',
      timeout: 60_000,
      windowsHide: true,
    },
  );
  if (windowSmoke) {
    // Exercise non-English first-load state; the watcher only reports changes.
    const profile = join(scratch, 'profiles', 'default');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'config.json'), JSON.stringify({ uiLocale: 'tr' }));
    const env = { ...process.env, WRONGSTACK_HOME: scratch };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = execFileSync(executable, ['--desktop-smoke-test'], {
      cwd: scratch,
      env,
      encoding: 'utf8',
      timeout: 45_000,
      windowsHide: true,
    });
    if (!result.includes('Desktop window ready'))
      throw new Error('Desktop did not report window readiness');
    console.log(result.trim());
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

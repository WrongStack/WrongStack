import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binaryCompileArgs } from '../../../../scripts/build-binaries.mjs';
import {
  bunSpawnInvocation,
  resolveBunExecutable,
} from '../../../../scripts/lib/bun-executable.mjs';

const root = resolve(import.meta.dirname, '../../../..');
let dir: string;
let executable: string;

beforeAll(async () => {
  mkdirSync(join(root, '.temp_files'), { recursive: true });
  dir = mkdtempSync(join(root, '.temp_files', 'production-renderer-'));
  executable = join(dir, process.platform === 'win32' ? 'renderer.exe' : 'renderer');
  const tuiRequire = createRequire(join(root, 'packages/tui/package.json'));
  const modulePath = (id: string) => JSON.stringify(tuiRequire.resolve(id).replaceAll('\\', '/'));
  const entry = join(dir, 'entry.mjs');
  writeFileSync(
    entry,
    `
// Mirror the CLI default before its lazy TUI import. Build-time folding must
// preserve production even when the invoking shell has no NODE_ENV or sets dev.
process.env['NODE_ENV'] ??= 'production';
const React = await import(${modulePath('react')});
const {render, Box, Text} = await import(${modulePath('ink')});
const {Writable, PassThrough} = await import('node:stream');
let outputText = '';
const output = new Writable({write(chunk, _encoding, done) { outputText += chunk.toString(); done(); }});
output.columns = 100; output.rows = 40; output.isTTY = false;
const stdin = new PassThrough(); stdin.isTTY = false;
const app = (tick) => React.createElement(Box, {flexDirection:'column'},
  Array.from({length:24}, (_, i) => React.createElement(Text, {key:i}, 'row '+i+' update '+tick)));
const instance = render(app(0), {stdout:output, stderr:output, stdin,
  interactive:false, patchConsole:false, exitOnCtrlC:false});
await instance.waitUntilRenderFlush();
for (let i=1; i<=300; i++) { instance.rerender(app(i)); await instance.waitUntilRenderFlush(); }
instance.unmount(); await instance.waitUntilExit();
const timings = performance.getEntriesByType('measure').length;
// Control: zero renderer timings must not come from disabling the timeline.
performance.mark('owned-control');
console.log(JSON.stringify({
  development:'actQueue' in React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
  timings, rendered:outputText.includes('update 300'),
  control:performance.getEntriesByName('owned-control').length
}));
`,
  );
  const bundled = join(dir, 'bundled.mjs');
  // Match the TUI's two-stage build: esbuild retains NODE_ENV branches, then
  // the standalone compiler folds them. Only the unused DevTools boundary is stubbed.
  await build({
    entryPoints: [entry],
    outfile: bundled,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'drop-devtools',
        setup(builder) {
          builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({
            path: 'devtools',
            namespace: 'empty',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({
            contents: 'export default {};',
          }));
        },
      },
    ],
  });
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const env = { ...process.env };
  delete env.NODE_ENV;
  const compile = bunSpawnInvocation(
    resolveBunExecutable(),
    binaryCompileArgs(
      `bun-${os}-${process.arch}`,
      { version: 'test', apiVersion: 'test', packId: 'test' },
      bundled,
      executable,
    ),
  );
  const result = spawnSync(compile.command, compile.args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    ...compile.options,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('standalone production renderer', () => {
  it.each([undefined, 'development', 'production'])(
    'avoids development timing retention with caller NODE_ENV=%s',
    (nodeEnv) => {
      const env = { ...process.env };
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
      const result = spawnSync(executable, [], {
        env,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout.trim());
      expect(observed.rendered).toBe(true);
      expect(observed.control).toBe(1);
      expect(observed.development).toBe(false);
      expect(observed.timings).toBe(0);
    },
  );
});

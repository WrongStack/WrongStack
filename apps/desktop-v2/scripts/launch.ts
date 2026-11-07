import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM build script without declarations.
import { engineSidecarPath, hostTriple } from './build-engine.mjs';
import { hostPortableSources, stagePortable } from './portable';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = fileURLToPath(new URL('../engine/main.ts', import.meta.url));
const backend = fileURLToPath(
  new URL('../../../packages/webui-server/dist/index.js', import.meta.url),
);
const mode = process.argv[2] ?? 'dev';
if (!['dev', 'build'].includes(mode)) throw new Error('Use dev or build');
// Launcher-only flag: the workspace was already built (CI builds it once up front).
const skipWorkspaceBuild = process.argv.includes('--skip-workspace-build');
const passthrough = process.argv.slice(3).filter((arg) => arg !== '--skip-workspace-build');
if (!existsSync(backend)) {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'desktop.engine_missing',
      message: 'Build the WrongStack engine first: bun run build',
      timestamp: new Date().toISOString(),
    }),
  );
  process.exit(1);
}
const appDir = fileURLToPath(new URL('../', import.meta.url));
const triple: string = hostTriple();

function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const child = spawn(process.execPath, args, { cwd: appDir, env, stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** Installers the bundler wrote for this build, newest first per format. */
function installers(): string[] {
  const bundle = join(appDir, 'src-tauri/target/release/bundle');
  const formats: Record<string, RegExp> = {
    nsis: /-setup\.exe$/,
    dmg: /\.dmg$/,
    deb: /\.deb$/,
    rpm: /\.rpm$/,
  };
  const found: string[] = [];
  for (const [format, pattern] of Object.entries(formats)) {
    const dir = join(bundle, format);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (files[0]) found.push(files[0]);
  }
  return found;
}

if (mode === 'build') {
  const args = ['scripts/build-engine.mjs', '--triple', triple];
  if (skipWorkspaceBuild) args.push('--skip-build');
  const code = await run(args);
  if (code !== 0) throw new Error(`Engine build exited ${code}`);
}
const engineId = createHash('sha256')
  .update(readFileSync(mode === 'build' ? (engineSidecarPath(triple, appDir) as string) : backend))
  .digest('hex');
// `build` merges the installer configuration (bundling on, engine sidecar, per-OS formats).
// `dev` keeps the base config, so development never needs a compiled engine.
const tauriArgs =
  mode === 'build'
    ? ['--bun', 'run', 'tauri', 'build', '--config', 'src-tauri/tauri.bundle.conf.json']
    : ['--bun', 'run', 'tauri', 'dev'];
const code = await run([...tauriArgs, ...passthrough], {
  ...process.env,
  WRONGSTACK_DESKTOP_ENGINE_ID: engineId,
  WRONGSTACK_DESKTOP_BUN: process.execPath,
  WRONGSTACK_DESKTOP_ENTRY: entry,
  WRONGSTACK_DESKTOP_REPO: root,
});
if (code === 0 && mode === 'build') {
  const built = installers();
  if (built.length === 0) {
    throw new Error('Tauri finished without an installer under src-tauri/target/release/bundle.');
  }
  for (const file of built) console.log(`Desktop installer: ${file}`);
  const ui = hostPortableSources(appDir, triple);
  if (existsSync(ui.ui)) console.log(`Portable desktop: ${stagePortable(appDir, ui)}`);
}
process.exit(code);

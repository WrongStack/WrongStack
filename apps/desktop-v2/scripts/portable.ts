import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM build script without declarations.
import { engineSidecarPath, hostTriple } from './build-engine.mjs';

export function portableDirectory(appDir: string): string {
  const root = join(appDir, 'dist-native');
  if (!existsSync(join(root, 'latest.json'))) return root;
  const latest = JSON.parse(readFileSync(join(root, 'latest.json'), 'utf8')) as {
    directory?: unknown;
  };
  if (typeof latest.directory !== 'string' || !/^[a-f0-9]{12}-[a-f0-9]{12}$/.test(latest.directory))
    throw new Error('Invalid portable build identity.');
  return join(root, latest.directory);
}

export interface PortableSources {
  /** Built application executable (the cargo output). */
  ui: string;
  /** Engine sidecar built for the same target. */
  engine: string;
  /** Executable suffix of the target platform. */
  suffix: '' | '.exe';
}

/** The host build's outputs: the cargo binary and the engine sidecar for the same triple. */
export function hostPortableSources(
  appDir: string,
  triple: string = hostTriple(),
): PortableSources {
  const suffix = triple.includes('-windows-') ? '.exe' : '';
  return {
    ui: join(appDir, `src-tauri/target/release/wrongstack-desktop-native${suffix}`),
    engine: engineSidecarPath(triple, appDir) as string,
    suffix,
  };
}

/**
 * Stage an immutable portable build (application + engine side by side) for local acceptance
 * runs. End users install the single bundled installer instead; see `scripts/launch.ts`.
 */
export function stagePortable(
  appDir: string,
  sources: PortableSources = hostPortableSources(appDir),
): string {
  const files = [
    [sources.ui, `wrongstack-desktop-native${sources.suffix}`],
    [sources.engine, `wrongstack-engine${sources.suffix}`],
  ] as const;
  const hashes = files.map(([source]) =>
    createHash('sha256').update(readFileSync(source)).digest('hex'),
  );
  const identity = hashes.map((hash) => hash.slice(0, 12)).join('-');
  const root = join(appDir, 'dist-native');
  const portable = join(root, identity);
  mkdirSync(portable, { recursive: true });
  const sums = files.map(([source, name], index) => {
    const file = join(portable, name);
    if (!existsSync(file)) copyFileSync(source, file);
    const expected = hashes[index];
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== expected)
      throw new Error(`Portable artifact identity changed: ${name}`);
    return `${expected}  ${name}`;
  });
  writeFileSync(join(portable, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  writeFileSync(join(root, 'latest.json'), `${JSON.stringify({ directory: identity }, null, 2)}\n`);
  return portable;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(stagePortable(fileURLToPath(new URL('../', import.meta.url))));
}

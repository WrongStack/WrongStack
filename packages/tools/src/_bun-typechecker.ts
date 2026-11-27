import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildChildEnv } from '@wrongstack/core/utils';

// An immutable npm release, rather than the moving GitHub canary download.
// This build includes Bun's TypeScript 7.0.2 checker. No npm lifecycle script runs.
export const BUN_TYPECHECK_VERSION = '1.4.2-canary.20261007.1';
const COMPILER_VERSION = '7.0.2';
const installations = new Map<string, Promise<string>>();

export function bunTypecheckCacheRoot(): string {
  return path.join(
    process.env['WRONGSTACK_HOME'] || path.join(homedir(), '.wrongstack'),
    'toolchains',
    'bun',
  );
}

export function bunPlatformPackage(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const operatingSystems: Record<string, string> = {
    win32: 'windows',
    linux: 'linux',
    darwin: 'darwin',
  };
  const architectures: Record<string, string> = { x64: 'x64', arm64: 'aarch64' };
  const os = operatingSystems[platform];
  const cpu = architectures[arch];
  if (!os || !cpu) throw new Error(`Bun type checking is unavailable on ${platform}/${arch}.`);
  const report = (platform === 'linux' ? process.report?.getReport() : undefined) as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const musl = platform === 'linux' && !report?.header?.glibcVersionRuntime;
  return `@oven/bun-${os}-${cpu}${musl ? '-musl' : ''}`;
}

/** Extract only the executable; archive paths are never written to disk. */
export function extractBunExecutable(archive: Buffer, executable: string): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = Number.parseInt(
      header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0',
      8,
    );
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) {
      throw new Error('Invalid Bun runtime archive.');
    }
    if (name === `package/bin/${executable}` && (header[156] === 0 || header[156] === 48)) {
      return tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Bun runtime archive has no ${executable}.`);
}

async function checkerWorks(binary: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const probe = await mkdtemp(path.join(tmpdir(), 'wrongstack-bun-check-'));
  try {
    await writeFile(path.join(probe, 'package.json'), '{"private":true}');
    await writeFile(
      path.join(probe, 'tsconfig.json'),
      '{"compilerOptions":{"types":[]},"files":["probe.ts"]}',
    );
    await writeFile(
      path.join(probe, 'probe.ts'),
      'const value: number = "bun-check-capability-probe";',
    );
    // A capability probe needs no credentials: never hand it the provider keys.
    const version = spawnSync(binary, ['-p', 'process.versions.typescript'], {
      cwd: probe,
      encoding: 'utf8',
      env: buildChildEnv(),
      timeout: 10_000,
      windowsHide: true,
    });
    if (version.status !== 0 || version.stdout.trim() !== COMPILER_VERSION) return false;
    const check = spawnSync(
      binary,
      ['check', '--pretty=false', '--threads=1', '-p', path.join(probe, 'tsconfig.json')],
      {
        cwd: probe,
        encoding: 'utf8',
        env: buildChildEnv(),
        timeout: 10_000,
        windowsHide: true,
      },
    );
    signal?.throwIfAborted();
    return check.status === 1 && /error TS2322:/.test(check.stdout);
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

async function installChecker(cacheRoot: string, signal?: AbortSignal): Promise<string> {
  const packageName = bunPlatformPackage();
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const destination = path.join(cacheRoot, BUN_TYPECHECK_VERSION, packageName.slice(6));
  const binary = path.join(destination, executable);
  if (await checkerWorks(binary, signal)) return binary;
  await mkdir(destination, { recursive: true });
  const networkSignal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(signal ? [signal] : []),
  ]);
  const metadataResponse = await fetch(
    `https://registry.npmjs.org/${packageName}/${BUN_TYPECHECK_VERSION}`,
    { signal: networkSignal },
  );
  if (!metadataResponse.ok)
    throw new Error(`Bun runtime metadata download failed (${metadataResponse.status}).`);
  const metadata = (await metadataResponse.json()) as {
    version: string;
    dist: { tarball: string; integrity: string };
  };
  const url = new URL(metadata.dist.tarball);
  if (
    metadata.version !== BUN_TYPECHECK_VERSION ||
    url.origin !== 'https://registry.npmjs.org' ||
    !metadata.dist.integrity.startsWith('sha512-')
  ) {
    throw new Error('Bun runtime metadata does not match the pinned release.');
  }
  const response = await fetch(url, { signal: networkSignal });
  if (!response.ok) throw new Error(`Bun runtime download failed (${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (
    `sha512-${createHash('sha512').update(archive).digest('base64')}` !== metadata.dist.integrity
  ) {
    throw new Error('Bun runtime integrity check failed.');
  }
  const staging = await mkdtemp(path.join(destination, 'install-'));
  try {
    const candidate = path.join(staging, executable);
    await writeFile(candidate, extractBunExecutable(archive, executable), { mode: 0o755 });
    if (!(await checkerWorks(candidate, signal)))
      throw new Error('Installed Bun does not provide the required TypeScript checker.');
    signal?.throwIfAborted();
    try {
      await link(candidate, binary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Hard-link publication is atomic and preserves executable permissions.
    if (!(await checkerWorks(binary, signal))) throw new Error(`Cached Bun is invalid: ${binary}`);
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function ensureBunTypechecker(
  options: { cacheRoot?: string; signal?: AbortSignal; onInstall?: () => void } = {},
): Promise<string> {
  const override = process.env['WRONGSTACK_BUN_TYPECHECK'];
  if (override) {
    if (await checkerWorks(override, options.signal)) return override;
    throw new Error(
      `WRONGSTACK_BUN_TYPECHECK does not provide a working TypeScript ${COMPILER_VERSION} checker.`,
    );
  }
  if (await checkerWorks('bun', options.signal)) return 'bun';
  const cacheRoot = path.resolve(options.cacheRoot ?? bunTypecheckCacheRoot());
  const existing = installations.get(cacheRoot);
  if (existing) return existing;
  options.onInstall?.();
  const installation = installChecker(cacheRoot, options.signal);
  installations.set(cacheRoot, installation);
  try {
    return await installation;
  } finally {
    installations.delete(cacheRoot);
  }
}

/** A private cwd prevents a project's `check` script from overriding Bun's checker. */
export async function bunTypecheckInvocation(
  cwd: string,
  args: readonly string[],
  options: {
    cacheRoot?: string;
    signal?: AbortSignal;
    onInstall?: () => void;
  } = {},
): Promise<{ cmd: string; args: string[]; cwd: string }> {
  // The checker runs from its own cache directory, so a missing project
  // directory would not fail the spawn: Bun would report on a path that does
  // not exist and the caller would read that as a type-check result. Refuse
  // up front, before provisioning the runtime.
  const projectDir = path.resolve(cwd);
  const isDir = await stat(projectDir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) throw new Error(`project directory does not exist: ${projectDir}`);
  const cmd = await ensureBunTypechecker(options);
  const cacheRoot = path.resolve(options.cacheRoot ?? bunTypecheckCacheRoot());
  const checkCwd = path.join(cacheRoot, 'check-cwd');
  await mkdir(checkCwd, { recursive: true });
  // Publish once, atomically, so concurrent checks never see a partial file
  // or replace a manifest another checker is reading (Windows sharing locks).
  const manifest = path.join(checkCwd, `package-${randomUUID()}.json`);
  await writeFile(manifest, '{"private":true}');
  const packageJson = path.join(checkCwd, 'package.json');
  try {
    await link(manifest, packageJson);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await rm(manifest, { force: true });
  }
  if ((await readFile(packageJson, 'utf8')) !== '{"private":true}') {
    throw new Error(`Bun checker cache has an unexpected package.json: ${packageJson}`);
  }
  const normalized = [...args];
  let hasProject = false;
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index] === '-p' || normalized[index] === '--project') {
      const project = normalized[index + 1];
      if (!project) throw new Error('Bun typecheck requires a path after --project.');
      normalized[index + 1] = path.resolve(cwd, project);
      hasProject = true;
      index++;
    } else if (normalized[index]?.startsWith('--project=')) {
      normalized[index] = `--project=${path.resolve(cwd, normalized[index]!.slice(10))}`;
      hasProject = true;
    }
  }
  if (!hasProject) normalized.push(path.resolve(cwd));
  return { cmd, args: ['check', '--pretty=false', '--threads=4', ...normalized], cwd: checkCwd };
}

/**
 * Bun's checker runs from a private cache cwd (above), so every diagnostic
 * path it prints is relative to THAT directory —
 * `../../../../../proj/src/a.ts(1,14): error TS2322` — a path the model can
 * neither read nor edit. Rebase each `file(line,col): error|warning TSnnnn`
 * path onto `projectDir`; paths outside it become absolute.
 */
export function rebaseCheckerPaths(output: string, checkerCwd: string, projectDir: string): string {
  if (!output || path.resolve(checkerCwd) === path.resolve(projectDir)) return output;
  return output.replace(
    /^([^\s(][^\n(]*?)(\(\d+,\d+\): (?:error|warning|message) TS\d+)/gm,
    (_match, file: string, rest: string) => {
      const abs = path.resolve(checkerCwd, file);
      const rel = path.relative(projectDir, abs);
      const outside =
        !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
      return `${(outside ? abs : rel).split(path.sep).join('/')}${rest}`;
    },
  );
}

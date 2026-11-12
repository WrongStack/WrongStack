import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';

type ProbeProcess = {
  kill(): unknown;
  on(event: 'error', listener: () => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
};
type SpawnProbe = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'ignore']; windowsHide: true },
) => ProbeProcess;

export interface ResolveServerCommandOptions {
  /**
   * Consult `<cwd>/…/node_modules/.bin` before PATH.
   *
   * **Defaults to `false`, and the default is the security boundary.**
   * `node_modules/.bin` lives inside the opened repository, so a repo that
   * commits `node_modules/.bin/typescript-language-server` (or any other
   * preset name — `gopls`, `clangd`, `rust-analyzer`, …) supplies the binary
   * this resolver returns, and the caller then spawns it. When the caller is
   * auto-discovery that is unattended code execution on repo open: WS-SEC-01.
   *
   * Pass `true` only where the *user* asked for this specific command in this
   * specific project — `/lsp setup`, `/lsp install`, `/lsp` — where adopting a
   * project-local server is the point and the user is present. Auto-discovery
   * must never pass it.
   *
   * Trust-on-first-use is deliberately NOT the mechanism here: TOFU pins on
   * first use, and for this attack the first use IS the attack.
   */
  allowProjectLocal?: boolean | undefined;
}

export async function resolveServerCommand(
  command: string,
  cwd: string,
  opts: ResolveServerCommandOptions = {},
): Promise<string | null> {
  // An absolute command was written down by whoever configured it rather than
  // discovered from the tree, so it is honoured on both paths. Presets are all
  // bare names, so auto-discovery never reaches this branch.
  if (path.isAbsolute(command)) {
    return (await fileExists(command)) ? path.normalize(command) : null;
  }
  if (opts.allowProjectLocal === true) {
    const local = await findLocalBinary(cwd, command);
    if (local) return local;
    return await resolveCommandOnPath(command);
  }
  // A bare name that `where.exe` finds is NOT spawnable on Windows: Node does
  // not apply PATHEXT, so `spawn('typescript-language-server')` ENOENTs even
  // though the `.cmd` shim sits right there on PATH. Resolve to the concrete
  // file so safeSpawn can see the extension and pick the shell it needs.
  //
  // PATH is not by itself proof of provenance: `npm run` / `pnpm run` / `npx`
  // prepend `<project>/node_modules/.bin` to PATH (and `where.exe` searches the
  // current directory first), so launching wstack inside a hostile repo puts
  // that repo's binaries on PATH and reopens WS-SEC-01 through this branch.
  // Project-local hits are skipped while choosing — refusing only the FIRST hit
  // left a shadowed user's trusted global server unused — and the gate below
  // still checks where the chosen file lives (POSIX `command -v` lists one).
  const onPath = await resolveCommandOnPath(
    command,
    undefined,
    (hit) => !isInsideProject(hit, cwd),
  );
  return gateProjectLocalPath(onPath, cwd);
}

function gateProjectLocalPath(onPath: string | null, cwd: string): string | null {
  return onPath !== null && isInsideProject(onPath, cwd) ? null : onPath;
}

/** True when `candidate` resolves inside the opened project tree. */
function isInsideProject(candidate: string, cwd: string): boolean {
  const root = path.resolve(cwd);
  const rel = path.relative(root, path.resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export async function findLocalBinary(cwd: string, command: string): Promise<string | null> {
  if (path.isAbsolute(command)) return (await fileExists(command)) ? path.normalize(command) : null;
  let dir = path.resolve(cwd);
  for (;;) {
    const binDir = path.join(dir, 'node_modules', '.bin');
    for (const candidate of commandCandidates(command)) {
      const full = path.join(binDir, candidate);
      if (await fileExists(full)) return full;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function commandExistsOnPath(command: string, timeoutMs = 2000): Promise<boolean> {
  return (await resolveCommandOnPath(command, timeoutMs)) !== null;
}

/**
 * Absolute path of `command` as found on PATH, or null. On Windows the
 * extension-less entry `where.exe` lists first is a POSIX shell script that
 * `spawn` cannot execute — prefer a PATHEXT-executable sibling.
 */
export async function resolveCommandOnPath(
  command: string,
  timeoutMs = 2000,
  accept?: ((hit: string) => boolean) | undefined,
): Promise<string | null> {
  if (process.platform === 'win32') {
    const hits = await windowsPathHits(command, buildChildEnv(), process.cwd(), readDirCached);
    return pickProbeHit(hits.join('\n'), 'win32', accept);
  }
  return commandProbe(command, timeoutMs, process.platform, spawn as unknown as SpawnProbe, accept);
}

/** The value of `name` in `env`, whose keys are case-insensitive on Windows (`Path`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * What `where.exe <command>` lists, in its order (the current directory, then each PATH
 * entry; in each, the bare name and then the name with every PATHEXT extension), found by
 * reading the directories instead of starting a process.
 *
 * Starting `where.exe` once per language-server preset cost 5–24 s of every engine boot on
 * Windows (process creation is synchronous there and blocks the event loop), and the desktop
 * starts an engine for every conversation it opens or resumes.
 */
async function windowsPathHits(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  readDir: (dir: string) => Promise<Map<string, string>>,
): Promise<string[]> {
  if (/[\\/:*?]/.test(command)) return [];
  const extensions = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
  const names = [command, ...extensions.map((ext) => command + ext)].map((name) =>
    name.toLowerCase(),
  );
  const dirs = [cwd, ...(envValue(env, 'PATH') ?? '').split(';')]
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const listings = await Promise.all(dirs.map((dir) => readDir(dir)));
  const hits: string[] = [];
  const seen = new Set<string>();
  listings.forEach((files, index) => {
    for (const name of names) {
      const file = files.get(name);
      if (file === undefined) continue;
      const full = path.join(dirs[index] as string, file);
      if (seen.has(full.toLowerCase())) continue;
      seen.add(full.toLowerCase());
      hits.push(full);
    }
  });
  return hits;
}

/** How long a directory listing answers PATH lookups; a boot asks for ~20 servers at once. */
const DIR_LISTING_TTL_MS = 5000;
const dirListings = new Map<string, { at: number; files: Promise<Map<string, string>> }>();

/** Regular files (and links) in `dir` by lower-cased name; empty when it cannot be read. */
function readDirCached(dir: string): Promise<Map<string, string>> {
  const key = dir.toLowerCase();
  const cached = dirListings.get(key);
  if (cached && Date.now() - cached.at < DIR_LISTING_TTL_MS) return cached.files;
  const files = fs
    .readdir(dir, { withFileTypes: true })
    .then(
      (entries) =>
        new Map(
          entries
            .filter((entry) => !entry.isDirectory())
            .map((entry) => [entry.name.toLowerCase(), entry.name] as const),
        ),
    )
    .catch(() => new Map<string, string>());
  dirListings.set(key, { at: Date.now(), files });
  return files;
}

function commandProbe(
  command: string,
  timeoutMs: number,
  platform: NodeJS.Platform,
  spawnProbe: SpawnProbe,
  accept?: ((hit: string) => boolean) | undefined,
): Promise<string | null> {
  const probe = platform === 'win32' ? 'where.exe' : 'sh';
  const args = platform === 'win32' ? [command] : ['-lc', `command -v ${shellQuote(command)}`];
  return new Promise((resolve) => {
    let out = '';
    const child = spawnProbe(probe, args, {
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? pickProbeHit(out, platform, accept) : null);
    });
  });
}

function pickProbeHit(
  stdout: string,
  platform: NodeJS.Platform,
  accept: (hit: string) => boolean = () => true,
): string | null {
  const hits = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(accept);
  const first = hits[0];
  if (first === undefined) return null;
  if (platform !== 'win32') return first;
  return hits.find((hit) => /\.(cmd|exe|bat|com)$/i.test(hit)) ?? first;
}

function commandCandidates(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') return [command];
  const ext = path.extname(command).toLowerCase();
  if (ext) return [command];
  return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command, `${command}.ps1`];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const commandResolverCoverage = {
  gateProjectLocalPath,
  commandCandidates,
  commandProbe,
  windowsPathHits,
  fileExists,
  pickProbeHit,
  shellQuote,
};

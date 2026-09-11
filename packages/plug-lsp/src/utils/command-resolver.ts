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
  const onPath = await resolveCommandOnPath(command);
  // PATH is not by itself proof of provenance: `npm run` / `pnpm run` / `npx`
  // prepend `<project>/node_modules/.bin` to PATH, so launching wstack through
  // a package script inside a hostile repo puts that repo's binaries on PATH
  // and reopens WS-SEC-01 through this branch. Gate on where the file actually
  // lives, which covers both the local walk above and PATH injection.
  return gateProjectLocalPath(onPath, cwd);
}

function gateProjectLocalPath(onPath: string | null, cwd: string): string | null {
  return onPath !== null && isInsideProject(onPath, cwd) ? null : onPath;
}

/** True when `candidate` resolves inside the opened project tree. */
function isInsideProject(candidate: string, cwd: string): boolean {
  const root = path.resolve(cwd);
  const rel = path.relative(root, path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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
): Promise<string | null> {
  return commandProbe(command, timeoutMs, process.platform, spawn as unknown as SpawnProbe);
}

function commandProbe(
  command: string,
  timeoutMs: number,
  platform: NodeJS.Platform,
  spawnProbe: SpawnProbe,
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
      resolve(code === 0 ? pickProbeHit(out, platform) : null);
    });
  });
}

function pickProbeHit(stdout: string, platform: NodeJS.Platform): string | null {
  const hits = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
  fileExists,
  pickProbeHit,
  shellQuote,
};

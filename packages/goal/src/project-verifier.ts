import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv, buildWin32CmdShimInvocation, toErrorMessage } from '@wrongstack/core/utils';
import { treeKill } from '@wrongstack/core/utils/tree-kill';

export interface GoalProjectVerifierOptions {
  cwd: string;
  projectRoot?: string | undefined;
  steps?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
}

export interface GoalProjectVerificationResult {
  ok: boolean;
  output?: string | undefined;
  skipped?: boolean | undefined;
}

const PACKAGE_MANAGERS = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
] as const;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string): Promise<string> {
  for (const [lockfile, manager] of PACKAGE_MANAGERS) {
    if (await exists(path.join(root, lockfile))) return manager;
  }
  return 'npm';
}

/**
 * The manifest's string scripts. Only a MISSING package.json means "nothing to
 * verify"; any other read or parse failure throws — npm cannot run a script
 * from it either, and treating it as "no scripts" returned skipped, which the
 * Goal hosts count as a pass.
 */
async function readScripts(cwd: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(cwd, 'package.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  // A leading UTF-8 BOM (npm runs such a manifest) must not read as "no scripts".
  const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as {
    scripts?: unknown;
  } | null;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('package.json is not a JSON object');
  }
  if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed.scripts).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );
}

async function runStep(
  manager: string,
  step: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  const args = ['run', step];
  const invocation =
    process.platform === 'win32'
      ? buildWin32CmdShimInvocation(manager, args)
      : { command: manager, args, windowsVerbatimArguments: false };
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      invocation.command,
      invocation.args,
      {
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: buildChildEnv(),
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        settled = true;
        clearTimeout(timer);
        const output = `${stdout}${stderr}`.trim();
        if (!err) {
          resolve({ ok: true, output });
          return;
        }
        resolve({
          ok: false,
          output: output || `${manager} run ${step} could not complete: ${toErrorMessage(err)}`,
        });
      },
    );
    // execFile's own `timeout` kills only the direct child — through the
    // cmd.exe shim that is cmd.exe, and the hung script kept running. Kill the
    // tree, and stop waiting on pipes a surviving descendant may still hold.
    if (settled) return;
    timer = setTimeout(() => {
      treeKill(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, timeoutMs);
  });
}

/**
 * Whether a bare command resolves on PATH (with PATHEXT). On win32 the cmd.exe
 * shim always exists, so a missing toolchain never surfaces as ENOENT — it
 * exits 1 with "is not recognized", indistinguishable from a failed check.
 */
async function win32CommandExists(command: string): Promise<boolean> {
  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const rawDir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    // cmd.exe accepts a quoted entry (`"C:\Program Files\Go\bin"`); joined
    // verbatim it names no file and an installed tool would read as missing.
    const dir = rawDir.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    for (const ext of ['', ...exts]) {
      if (ext === '' && !path.extname(command)) continue;
      if (await exists(path.join(dir, command + ext))) return true;
    }
  }
  return false;
}

async function runBinary(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  label: string,
): Promise<{ ok: boolean; output: string; missingBinary?: boolean }> {
  if (process.platform === 'win32' && !(await win32CommandExists(command))) {
    return { ok: true, output: `verify skipped: ${command} not found`, missingBinary: true };
  }
  const invocation =
    process.platform === 'win32'
      ? buildWin32CmdShimInvocation(command, [...args])
      : { command, args: [...args], windowsVerbatimArguments: false };
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      invocation.command,
      invocation.args,
      {
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: buildChildEnv(),
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        settled = true;
        clearTimeout(timer);
        const output = `${stdout}${stderr}`.trim();
        if (!err) {
          resolve({ ok: true, output });
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({
            ok: true,
            output: `verify skipped: ${command} not found`,
            missingBinary: true,
          });
          return;
        }
        resolve({
          ok: false,
          output: output || `${label} could not complete: ${toErrorMessage(err)}`,
        });
      },
    );
    if (settled) return;
    timer = setTimeout(() => {
      treeKill(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, timeoutMs);
  });
}

/** Run the same narrow package-script or native toolchain verification contract for every Goal host. */
export async function verifyGoalProject(
  options: GoalProjectVerifierOptions,
): Promise<GoalProjectVerificationResult> {
  const root = options.projectRoot ?? options.cwd;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const hasCwdPackageJson = await exists(path.join(options.cwd, 'package.json'));
  const hasPackageJson = hasCwdPackageJson || (await exists(path.join(root, 'package.json')));

  if (!hasPackageJson) {
    if (
      (await exists(path.join(options.cwd, 'Cargo.toml'))) ||
      (await exists(path.join(root, 'Cargo.toml')))
    ) {
      const targetDir = (await exists(path.join(options.cwd, 'Cargo.toml'))) ? options.cwd : root;
      const res = await runBinary(
        'cargo',
        ['check', '--quiet'],
        targetDir,
        timeoutMs,
        'cargo check',
      );
      if (res.missingBinary) return { ok: true, skipped: true, output: res.output };
      return res.ok ? { ok: true } : { ok: false, output: `[cargo check] ${res.output}` };
    }
    if (
      (await exists(path.join(options.cwd, 'go.mod'))) ||
      (await exists(path.join(root, 'go.mod')))
    ) {
      const targetDir = (await exists(path.join(options.cwd, 'go.mod'))) ? options.cwd : root;
      const res = await runBinary('go', ['vet', './...'], targetDir, timeoutMs, 'go vet');
      if (res.missingBinary) return { ok: true, skipped: true, output: res.output };
      return res.ok ? { ok: true } : { ok: false, output: `[go vet] ${res.output}` };
    }
    if (
      (await exists(path.join(options.cwd, 'pyproject.toml'))) ||
      (await exists(path.join(root, 'pyproject.toml')))
    ) {
      const targetDir = (await exists(path.join(options.cwd, 'pyproject.toml')))
        ? options.cwd
        : root;
      const res = await runBinary(
        'ruff',
        ['check', '--quiet', '.'],
        targetDir,
        timeoutMs,
        'ruff check',
      );
      if (res.missingBinary) return { ok: true, skipped: true, output: res.output };
      return res.ok ? { ok: true } : { ok: false, output: `[ruff check] ${res.output}` };
    }
    if (
      (await exists(path.join(options.cwd, 'Package.swift'))) ||
      (await exists(path.join(root, 'Package.swift')))
    ) {
      const targetDir = (await exists(path.join(options.cwd, 'Package.swift')))
        ? options.cwd
        : root;
      const res = await runBinary('swift', ['build'], targetDir, timeoutMs, 'swift build');
      if (res.missingBinary) return { ok: true, skipped: true, output: res.output };
      return res.ok ? { ok: true } : { ok: false, output: `[swift build] ${res.output}` };
    }
    if (
      (await exists(path.join(options.cwd, 'pubspec.yaml'))) ||
      (await exists(path.join(root, 'pubspec.yaml')))
    ) {
      const targetDir = (await exists(path.join(options.cwd, 'pubspec.yaml'))) ? options.cwd : root;
      const res = await runBinary('dart', ['analyze'], targetDir, timeoutMs, 'dart analyze');
      if (res.missingBinary) return { ok: true, skipped: true, output: res.output };
      return res.ok ? { ok: true } : { ok: false, output: `[dart analyze] ${res.output}` };
    }
    if (
      (await exists(path.join(options.cwd, 'mix.exs'))) ||
      (await exists(path.join(root, 'mix.exs')))
    ) {
      const targetDir = (await exists(path.join(options.cwd, 'mix.exs'))) ? options.cwd : root;
      const res = await runBinary('mix', ['compile'], targetDir, timeoutMs, 'mix compile');
      if (res.missingBinary) return { ok: true, skipped: true, output: res.output };
      return res.ok ? { ok: true } : { ok: false, output: `[mix compile] ${res.output}` };
    }
  }

  if (
    !(await exists(path.join(options.cwd, 'node_modules'))) &&
    !(await exists(path.join(root, 'node_modules')))
  ) {
    return { ok: true, skipped: true, output: 'verify skipped: node_modules not found' };
  }

  const jsTargetDir = hasCwdPackageJson ? options.cwd : root;
  let scripts: Record<string, string>;
  try {
    scripts = await readScripts(jsTargetDir);
  } catch (err) {
    return {
      ok: false,
      output: `[verify] package.json could not be read: ${(err as Error).message}`,
    };
  }
  const steps = (options.steps ?? ['typecheck', 'lint']).filter(
    (step) => Object.hasOwn(scripts, step) && Boolean(scripts[step]),
  );
  if (steps.length === 0) {
    return { ok: true, skipped: true, output: 'verify skipped: no configured scripts' };
  }

  const manager = await detectPackageManager(root);
  for (const step of steps) {
    const result = await runStep(manager, step, jsTargetDir, options.timeoutMs ?? 120_000);
    if (!result.ok) return { ok: false, output: `[${step}] ${result.output}` };
  }
  return { ok: true };
}

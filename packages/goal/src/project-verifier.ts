import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import { toErrorMessage } from '@wrongstack/core/utils';
import { treeKill } from '@wrongstack/core/utils/tree-kill';
import { buildWin32CmdShimInvocation } from '@wrongstack/core/utils';

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

/** Run the same narrow package-script verification contract for every Goal host. */
export async function verifyGoalProject(
  options: GoalProjectVerifierOptions,
): Promise<GoalProjectVerificationResult> {
  const root = options.projectRoot ?? options.cwd;
  if (
    !(await exists(path.join(options.cwd, 'node_modules'))) &&
    !(await exists(path.join(root, 'node_modules')))
  ) {
    return { ok: true, skipped: true, output: 'verify skipped: node_modules not found' };
  }

  let scripts: Record<string, string>;
  try {
    scripts = await readScripts(options.cwd);
  } catch (err) {
    return {
      ok: false,
      output: `[verify] package.json could not be read: ${(err as Error).message}`,
    };
  }
  const steps = (options.steps ?? ['typecheck', 'lint']).filter((step) => scripts[step]);
  if (steps.length === 0) {
    return { ok: true, skipped: true, output: 'verify skipped: no configured scripts' };
  }

  const manager = await detectPackageManager(root);
  for (const step of steps) {
    const result = await runStep(manager, step, options.cwd, options.timeoutMs ?? 120_000);
    if (!result.ok) return { ok: false, output: `[${step}] ${result.output}` };
  }
  return { ok: true };
}

import { spawn } from 'node:child_process';
import type { Tool } from '@wrongstack/core/types';
import { buildChildEnv } from '@wrongstack/core/utils';
import { detectPackageManager, safeResolve } from './_util.js';
import { buildWin32CmdShimInvocation, resolveWin32Command } from './_win32-resolve.js';

interface OutdatedInput {
  cwd?: string | undefined;
  format?: 'list' | 'table' | undefined;
  include_deprecated?: boolean | undefined;
  check?: string | string[] | undefined;
}

interface OutdatedPackage {
  name: string;
  current: string;
  latest: string;
  wanted: string;
  type: string;
  location: string;
}

interface OutdatedOutput {
  exit_code: number;
  packages: OutdatedPackage[];
  total: number;
  output: string;
  truncated: boolean;
}

export const outdatedTool: Tool<OutdatedInput, OutdatedOutput> = {
  name: 'outdated',
  category: 'Package Management',
  description:
    'Check for outdated dependencies in the project. Reports current, wanted (semver range), and latest versions available.',
  usageHint:
    'MAINTENANCE & SECURITY TOOL:\n\n' +
    '- Run periodically or before dependency-related work.\n' +
    '- Helps surface packages that may need updates for security or features.\n' +
    '- Hits the package registry over HTTP, so it is NOT purely local — flagged as mutating for the confirmation gate.\n' +
    'Use the output to decide on upgrades. Prefer this over manual shell commands for dependency hygiene.',
  permission: 'confirm',
  icon: 'package',
  // Network side-effecting (registry HTTP). Pairs with `mutating: true`
  // so the H7 invariant test (`no auto-permission tool declares
  // mutating: true`) passes — a tool claiming `'auto'` must be purely
  // read-only, but `outdated` makes outbound HTTP calls to the
  // registry. The 'confirm' permission routes the call through the
  // tool.confirm_needed flow on every invocation. M-1 originally
  // fixed four sibling tools (mcp_control, shellcheck, shellcheck (scan mode),
  // search) but missed this one; applying the same contract here.
  // WS-046: gives permission decisions something to key on.
  // The working directory scanned.
  subjectKey: 'cwd',
  mutating: true,
  // Capability is outbound network — the tool only hits the package
  // registry over HTTP, never touches the filesystem or runs shell.
  // Use the canonical `net.outbound` capability (not the non-existent
  // `network` string) so the subagent allowlist recognises it and
  // permits read-only registry lookups under a director.
  // The H7 invariant test requires this array to be non-empty for
  // any mutating:true tool (meta-tools whitelisted). See
  // tests/permission-mutating-invariant.test.ts:92.
  capabilities: ['net.outbound'],
  timeoutMs: 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
      format: {
        type: 'string',
        enum: ['list', 'table'],
        description: 'Output format (default: list)',
      },
      include_deprecated: {
        type: 'boolean',
        description: 'Include deprecated packages (default: false)',
      },
      check: {
        type: 'string',
        description: 'Specific package(s) to check (comma-separated)',
      },
    },
  },
  async execute(input, ctx, opts) {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const manager = await detectPackageManager(cwd);

    // When no JS package manager was detected (npm is the fallback), try the
    // language bridge for non-JS ecosystems. The bridge is checked AFTER
    // detectPackageManager so the legacy stat-based detection runs first.
    if (manager === 'npm') {
      try {
        const { detectNonJsEcosystem } = await import('./languages/legacy-bridge.js');
        const nonJs = await detectNonJsEcosystem(cwd, ctx.projectRoot);
        if (nonJs) {
          const { planLanguageOperation, executePackagePlan } = await import(
            './languages/index.js'
          );
          const planResult = await planLanguageOperation({
            projectRoot: ctx.projectRoot,
            cwd,
            operation: 'package-outdated',
            language: nonJs,
            signal: opts.signal,
          });
          if (planResult.status === 'planned') {
            const runner = executePackagePlan({
              projectRoot: ctx.projectRoot,
              workspace: planResult.workspace,
              plan: planResult.plan,
              packages: [],
              signal: opts.signal,
            });
            let outcome = null;
            for (;;) {
              const next = await runner.next();
              if (next.done) {
                outcome = next.value;
                break;
              }
            }
            if (outcome) {
              const packages = outcome.outdated.map((o) => ({
                name: o.name,
                current: o.previous ?? 'unknown',
                latest: o.resolved ?? 'unknown',
                wanted: o.requested ?? o.resolved ?? 'unknown',
                type: 'unknown',
                location: o.name,
              }));
              return {
                exit_code: outcome.run?.exitCode ?? 0,
                packages,
                total: packages.length,
                output:
                  outcome.run?.output ?? (packages.length === 0 ? 'All packages up to date' : ''),
                truncated: outcome.run?.truncated ?? false,
              };
            }
          }
        }
      } catch {
        // Bridge not available — fall through to npm outdated.
      }
    }

    const args: string[] = ['outdated', '--json'];
    if (input.format === 'table') args.push('--table');
    if (input.include_deprecated) args.push('--include', 'deprecated');

    return runOutdated(manager, args, cwd, opts.signal);
  },
};

function runOutdated(
  manager: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<OutdatedOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const MAX = 100_000;

    const resolved = resolveWin32Command(manager);
    const needsShell =
      process.platform === 'win32' && (resolved.endsWith('.cmd') || resolved.endsWith('.bat'));
    const shim = needsShell ? buildWin32CmdShimInvocation(resolved, args) : null;
    const spawnCmd = shim?.command ?? resolved;
    const spawnArgs = shim?.args ?? args;
    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      signal,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(shim ? { windowsVerbatimArguments: shim.windowsVerbatimArguments } : {}),
    });
    child.stdout?.on('data', (c) => {
      if (stdout.length < MAX) stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      if (stderr.length < MAX) stderr += c.toString();
    });
    child.on('close', (code) => {
      const result = parseOutdatedOutput(stdout, code ?? 0);
      resolve(result);
    });
    child.on('error', (e) => {
      resolve({
        exit_code: 1,
        packages: [],
        total: 0,
        output: e.message,
        truncated: false,
      });
    });
  });
}

function parseOutdatedOutput(json: string, exitCode: number): OutdatedOutput {
  const packages: OutdatedPackage[] = [];

  if (!json) {
    return {
      exit_code: exitCode,
      packages: [],
      total: 0,
      output: exitCode === 0 ? 'All packages up to date' : 'Could not check outdated packages',
      truncated: false,
    };
  }

  try {
    const data = JSON.parse(json);
    for (const name of Object.keys(data)) {
      const info = data[name];
      packages.push({
        name,
        current: info.current ?? 'unknown',
        latest: info.latest ?? 'unknown',
        wanted: info.wanted ?? 'unknown',
        type: info.type ?? 'unknown',
        location: info.location ?? name,
      });
    }
  } catch {
    // JSON parse failed, return raw output
  }

  return {
    exit_code: exitCode,
    packages,
    total: packages.length,
    output: json,
    truncated: json.length >= 100_000,
  };
}

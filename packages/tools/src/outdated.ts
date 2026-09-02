import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { buildChildEnv } from '@wrongstack/core/utils';
import {
  COMMAND_OUTPUT_MAX_BYTES,
  detectPackageManager,
  normalizeCommandOutput,
  safeResolveReal,
} from './_util.js';
import { buildWin32CmdShimInvocation, resolveWin32Command } from './_win32-resolve.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';

interface OutdatedInput {
  cwd?: string | undefined;
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

type OutdatedContext = Parameters<Tool<OutdatedInput, OutdatedOutput>['execute']>[1];

export const outdatedTool = {
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
    },
  },
  async execute(input: OutdatedInput, ctx: OutdatedContext, opts?: { signal: AbortSignal }) {
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) {
      throw new ToolValidationError({
        message: 'outdated: cwd must be a non-empty string when provided.',
        field: 'cwd',
      });
    }

    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : ctx.cwd;
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const manager = await detectPackageManager(cwd, ctx.projectRoot);

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
            signal,
          });
          if (planResult.status === 'planned') {
            const runner = executePackagePlan({
              projectRoot: ctx.projectRoot,
              workspace: planResult.workspace,
              plan: planResult.plan,
              packages: [],
              signal,
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

    // JSON is the only parse path; npm/pnpm have no `--table` or
    // `--include deprecated` flags, so no formatting options are forwarded.
    const args: string[] = ['outdated', '--json'];

    return runOutdated(manager, args, cwd, signal);
  },
} satisfies Tool<OutdatedInput, OutdatedOutput>;

function runOutdated(
  manager: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<OutdatedOutput> {
  if (signal.aborted) {
    return Promise.resolve({
      exit_code: 124,
      packages: [],
      total: 0,
      output: 'Aborted',
      truncated: false,
    });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const MAX = 100_000;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

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

    const registry = getProcessRegistry();
    if (typeof child.pid === 'number') {
      registry.register({
        pid: child.pid,
        name: manager,
        command: redactCommand(`${spawnCmd} ${args.join(' ')}`),
        startedAt: Date.now(),
        child,
      });
    }
    const onAbort = () => {
      if (typeof child.pid === 'number') {
        registry.kill(child.pid, { force: true });
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (c: Buffer) => {
      stdoutBytes += c.byteLength;
      if (stdout.length < MAX) {
        const text = stdoutDecoder.write(c);
        stdout += text.slice(0, MAX - stdout.length);
      }
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderrBytes += c.byteLength;
      if (stderr.length < MAX) {
        const text = stderrDecoder.write(c);
        stderr += text.slice(0, MAX - stderr.length);
      }
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (typeof child.pid === 'number') registry.unregister(child.pid);
      if (signal.aborted) {
        resolve({
          exit_code: 124,
          packages: [],
          total: 0,
          output: 'Aborted',
          truncated: false,
        });
        return;
      }
      const restOut = stdoutDecoder.end();
      if (restOut && stdout.length < MAX) {
        stdout += restOut.slice(0, MAX - stdout.length);
      }
      const isTruncated =
        stdoutBytes > MAX ||
        stderrBytes > MAX ||
        Buffer.byteLength(stdout, 'utf8') > COMMAND_OUTPUT_MAX_BYTES;
      const result = parseOutdatedOutput(stdout, code ?? 0, stderr, isTruncated);
      resolve(result);
    });
    child.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (typeof child.pid === 'number') registry.unregister(child.pid);
      if (signal.aborted || e.name === 'AbortError') {
        resolve({
          exit_code: 124,
          packages: [],
          total: 0,
          output: 'Aborted',
          truncated: false,
        });
        return;
      }
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

function parseOutdatedOutput(
  json: string,
  exitCode: number,
  stderr = '',
  truncated = false,
): OutdatedOutput {
  const packages: OutdatedPackage[] = [];

  if (!json) {
    return {
      exit_code: exitCode,
      packages: [],
      total: 0,
      output:
        stderr ||
        (exitCode === 0 ? 'All packages up to date' : 'Could not check outdated packages'),
      truncated: truncated,
    };
  }

  const isTruncated =
    truncated ||
    json.length >= 100_000 ||
    Buffer.byteLength(json, 'utf8') > COMMAND_OUTPUT_MAX_BYTES;
  let parsedOk = false;

  try {
    const data = JSON.parse(json) as Record<string, unknown>;
    parsedOk = true;
    for (const name of Object.keys(data)) {
      const info = (data[name] ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      packages.push({
        name,
        current: str(info['current']) ?? 'unknown',
        latest: str(info['latest']) ?? 'unknown',
        wanted: str(info['wanted']) ?? 'unknown',
        // npm calls it `type`; pnpm calls it `dependencyType`.
        type: str(info['type']) ?? str(info['dependencyType']) ?? 'unknown',
        location: str(info['location']) ?? name,
      });
    }
  } catch {
    // JSON parse failed, return raw output
  }

  // Both npm and pnpm exit 1 when outdated packages exist — that is the
  // expected "found something" signal, not a failure. Normalize to 0 so the
  // caller doesn't treat a successful check as an error.
  const outdatedFound = parsedOk && exitCode === 1;
  let output = normalizeCommandOutput(json);
  if (outdatedFound) {
    output = `${output}\n\nNote: exit code 1 from \`outdated\` means outdated packages were found (expected); treated as success.`;
  }

  return {
    exit_code: outdatedFound ? 0 : exitCode,
    packages,
    total: packages.length,
    output,
    truncated: isTruncated,
  };
}

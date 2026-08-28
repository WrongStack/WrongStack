import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  type MailboxBridgeLock,
  readLiveLock,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import { wstackGlobalRoot } from '@wrongstack/core/utils';

interface MailboxBridgeParams {
  projectRoot: string;
  config: { features?: { mailboxBridge?: 'auto' | 'off' | undefined } } | undefined;
  logger: {
    debug: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    info: (msg: string, meta?: Record<string, unknown>) => void;
  };
  ctx: { meta: Record<string, unknown> };
}

const MAILBOX_BRIDGE_BOOT_TIMEOUT_MS = 5_000;

/**
 * Attempt to discover and join a running mailbox bridge server.
 *
 * If no healthy bridge is present, standalone WebUI surfaces try to
 * spawn `wstack mailbox serve` and wait briefly for the lock to become
 * healthy. Failure stays non-fatal: the WebUI can run without external
 * agent HTTP connectivity.
 *
 * Gated on `features.mailboxBridge`, which defaults to 'off' — the
 * bridge only serves EXTERNAL agents and no WebUI code path reads the
 * handle stashed on `ctx.meta`, so a detached ~130 MB CLI process per
 * project was overhead nobody collected on. Opt in with 'auto'.
 */
export async function discoverMailboxBridgeForWebui(params: MailboxBridgeParams): Promise<void> {
  const mode = params.config?.features?.mailboxBridge ?? 'off';
  if (mode === 'off') return;

  const projectDir = resolveProjectDir(params.projectRoot, wstackGlobalRoot());
  let result = await readLiveLock(projectDir);
  let spawnedPid: number | null = null;
  if (result.kind !== 'live') {
    spawnedPid = spawnMailboxBridge(params.projectRoot, params.logger);
    if (spawnedPid !== null) {
      const live = await waitForLiveMailboxBridge(projectDir, MAILBOX_BRIDGE_BOOT_TIMEOUT_MS);
      if (live) {
        stashBridge(params, live, projectDir, 'spawned', spawnedPid);
        params.logger.debug('webui spawned mailbox bridge', {
          url: live.url,
          lockPath: projectDir,
          childPid: spawnedPid,
        });
        return;
      }
      result = await readLiveLock(projectDir);
    }
  }
  switch (result.kind) {
    case 'live': {
      params.logger.debug('webui joined existing mailbox bridge', {
        url: result.lock.url,
        lockPath: projectDir,
      });
      stashBridge(params, result.lock, projectDir, 'joined', null);
      break;
    }
    case 'probe-failed': {
      params.logger.warn(
        'mailbox bridge present but /healthz unreachable; webui will start without external-agent connectivity',
        { url: result.lock.url, lockPath: projectDir, spawnedPid },
      );
      stashBridge(params, result.lock, projectDir, 'unhealthy', null);
      break;
    }
    case 'absent': {
      params.logger.warn(
        'mailbox bridge unavailable; webui will start without external-agent connectivity. Run `wstack mailbox serve` or a CLI surface to bring one up.',
        { projectDir, spawnedPid },
      );
      break;
    }
  }
}

function stashBridge(
  params: MailboxBridgeParams,
  lock: MailboxBridgeLock,
  lockPath: string,
  source: 'joined' | 'spawned' | 'unhealthy',
  childPid: number | null,
): void {
  params.ctx.meta['mailboxBridge'] = {
    url: lock.url,
    token: lock.token,
    lockPath,
    childPid,
    source,
  };
}

async function waitForLiveMailboxBridge(
  projectDir: string,
  timeoutMs: number,
): Promise<MailboxBridgeLock | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(120);
    const result = await readLiveLock(projectDir);
    if (result.kind === 'live') return result.lock;
  }
  return null;
}

function spawnMailboxBridge(
  projectRoot: string,
  logger: MailboxBridgeParams['logger'],
): number | null {
  const invocation = mailboxServeInvocation(projectRoot);
  try {
    const child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      detached: process.platform !== 'win32' && !invocation.useShell,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
      ...(invocation.useShell ? { shell: true } : {}),
    });
    child.once('error', (err) => {
      logger.warn('failed to spawn mailbox bridge for webui', {
        command: invocation.command,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    child.unref();
    return child.pid ?? null;
  } catch (err) {
    logger.warn('failed to spawn mailbox bridge for webui', {
      command: invocation.command,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function mailboxServeInvocation(projectRoot: string): {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean | undefined;
  useShell?: boolean | undefined;
} {
  const explicitCliEntry = process.env['WRONGSTACK_CLI_ENTRY'];
  if (explicitCliEntry) {
    return { command: process.execPath, args: [explicitCliEntry, 'mailbox', 'serve'] };
  }
  try {
    const require = createRequire(import.meta.url);
    const cliEntry = require.resolve('@wrongstack/cli');
    return { command: process.execPath, args: [cliEntry, 'mailbox', 'serve'] };
  } catch {
    // @wrongstack/cli is not in webui-server's declared dependencies, so
    // pnpm does not symlink it into this package's node_modules and
    // require.resolve() above fails. Walk up from projectRoot looking for
    // a sibling `packages/cli/dist/index.js` (the workspace layout the
    // monorepo CLI ships) and run it directly with process.execPath.
    //
    // This avoids:
    //   - `spawn wstack.cmd` failing with EINVAL (Node 20+ refuses to
    //     spawn `.cmd`/`.bat` without `shell: true` — CVE-2024-27980).
    //   - relying on a globally-installed `wstack` that may not exist on
    //     developer machines that only run the monorepo.
    const workspaceCliEntry = findWorkspaceCliEntry(projectRoot);
    if (workspaceCliEntry) {
      return {
        command: process.execPath,
        args: [workspaceCliEntry, 'mailbox', 'serve'],
      };
    }
    // Last resort: try the on-PATH shim. On Windows, spawning a `.cmd`
    // requires `shell: true` since Node 20 (CVE-2024-27980) — without
    // it, spawn() rejects with EINVAL.
    if (process.platform === 'win32') {
      return {
        command: 'wstack.cmd',
        args: ['mailbox', 'serve'],
        useShell: true,
      };
    }
    return { command: 'wstack', args: ['mailbox', 'serve'] };
  }
}

/**
 * Walk up from `projectRoot` looking for a sibling `packages/cli/dist/index.js`.
 * Works for the published monorepo layout (projectRoot = monorepo root) and
 * for extracted checkouts where the workspace sits a few levels above.
 */
function findWorkspaceCliEntry(projectRoot: string): string | null {
  let dir = projectRoot;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages', 'cli', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

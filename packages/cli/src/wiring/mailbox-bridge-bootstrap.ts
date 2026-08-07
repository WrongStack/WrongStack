/**
 * mailbox-bridge-bootstrap wiring — boot-time integration glue.
 *
 * Called from each WrongStack boot surface (REPL/TUI via cli-main,
 * webui-server, eternal-autonomy) BEFORE the agent constructs its
 * mailbox checker. Resolves the project directory, gates on
 * `config.features.mailboxBridge`, and either joins the existing
 * bridge or spawns a fresh one via `tryAcquireMailboxBridge`.
 *
 * Never throws — bootstrap failures degrade to a warning + no bridge,
 * matching the contract of the underlying helper. The agent still
 * reaches the project mailbox over IPC; only external-agent HTTP
 * access is impacted.
 *
 * The handle is stashed on `ctx.meta['mailboxBridge']` so any later
 * surface (mailbox HTTP server, /mailbox-serve slash command, hq
 * publisher) can read the bridge URL/token without re-running
 * discovery.
 */

import { resolveProjectDir } from '@wrongstack/core/coordination';
import type { Config, Logger } from '@wrongstack/core/types';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { type MailboxBridgeHandle, tryAcquireMailboxBridge } from '../mailbox-bridge-bootstrap.js';

/** Where on ctx.meta the bootstrap handle lives. */
export const MAILBOX_BRIDGE_META_KEY = 'mailboxBridge';

/**
 * Best-effort boot-time bridge bootstrap. Returns the handle
 * (which may have source='failed' or be a no-op stub when the
 * feature is disabled) or `null` when there's no project root to
 * bootstrap against.
 *
 * Side effect: stashes the handle on `ctx.meta[MAILBOX_BRIDGE_META_KEY]`
 * when `ctx` is provided, so subsequent code paths can find it
 * without re-running discovery.
 */
export async function bootstrapMailboxBridgeAtStartup(params: {
  projectRoot: string | undefined;
  config: { features: Pick<Config['features'], 'mailboxBridge'> } | undefined;
  logger: Logger;
  /** Surface label — logged for debugging when something goes wrong. */
  source: 'cli' | 'webui' | 'eternal';
  /** Optional override for the spawn timeout (default 5s). */
  timeoutMs?: number;
  /** The agent's Context, if available. The handle is stashed here. */
  ctx?: { meta: Record<string, unknown> } | undefined;
}): Promise<MailboxBridgeHandle | null> {
  if (!params.projectRoot) {
    return null;
  }
  // Default to 'off' when the field is undefined — matches the docstring
  // on Config.features.mailboxBridge. The bridge serves EXTERNAL agents
  // only; nothing inside WrongStack reads the handle we stash below
  // (`readBootstrappedBridge` has no production caller), so spawning a
  // detached ~130 MB CLI process on every boot was pure overhead for the
  // majority of users. Opt in with `features.mailboxBridge: "auto"`, or
  // start it on demand with `/mailbox-serve` / `wstack mailbox serve`.
  const mode = params.config?.features?.mailboxBridge ?? 'off';
  if (mode === 'off') {
    return null;
  }

  const projectDir = resolveProjectDir(params.projectRoot, wstackGlobalRoot());
  let handle: MailboxBridgeHandle;
  try {
    handle = await tryAcquireMailboxBridge({
      projectDir,
      projectRoot: params.projectRoot,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
  } catch (err) {
    // tryAcquireMailboxBridge is documented as never-throws — but if
    // it ever does (e.g. a regression in the bootstrap helper), we
    // degrade to no-bridge rather than block startup.
    params.logger.warn(
      `mailbox bridge bootstrap threw unexpectedly on ${params.source} boot; continuing without bridge`,
      { err: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }

  switch (handle.source) {
    case 'joined':
    case 'spawned':
      // Happy path — log a short breadcrumb so a user wondering
      // "where's the bridge come from?" can trace it from the boot
      // log of any WrongStack surface.
      params.logger.debug(`mailbox bridge ready via ${handle.source} on ${params.source} boot`, {
        url: handle.url,
        lockPath: handle.lockPath,
      });
      break;
    case 'unhealthy':
      // The bridge is alive (lock present, PID live) but /healthz
      // didn't respond. We still return the URL/token so the caller
      // can surface a real fetch error if the bridge is truly dead —
      // don't suppress it with a warning.
      params.logger.warn(
        `mailbox bridge present but /healthz unreachable on ${params.source} boot`,
        { url: handle.url, lockPath: handle.lockPath },
      );
      break;
    case 'failed':
      params.logger.warn(
        `mailbox bridge unavailable on ${params.source} boot; external agents won't be able to connect until you run \`wstack mailbox serve\` manually`,
        { projectDir },
      );
      break;
  }

  if (params.ctx) {
    params.ctx.meta[MAILBOX_BRIDGE_META_KEY] = handle;
  }
  return handle;
}

/**
 * Read a previously-bootstrapped bridge handle from ctx.meta. Returns
 * null when no bootstrap ran (e.g. feature disabled, no projectRoot,
 * bootstrap failed and the caller didn't stash the failure stub).
 */
export function readBootstrappedBridge(
  meta: Record<string, unknown> | undefined,
): MailboxBridgeHandle | null {
  const v = meta?.[MAILBOX_BRIDGE_META_KEY];
  if (!v || typeof v !== 'object') return null;
  const h = v as MailboxBridgeHandle;
  if (typeof h.source !== 'string' || typeof h.url !== 'string') return null;
  return h;
}

import { resolveHqConfig } from '@wrongstack/hq';
import { SageProjectServerConnection } from '@wrongstack/sage';
import { startCliHqConnection } from '../../hq-publisher.js';
import type { SubcommandDeps } from '../contracts.js';

/** A memory-only HQ connection for headless hosts and upgrading active sessions. */
export async function runSageHqSyncCommand(
  deps: SubcommandDeps,
  restartService: boolean,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) return 0;
  if (!resolveHqConfig({ config: deps.config.hq })?.enabled) {
    deps.renderer.writeError('HQ is disabled. Enable HQ before starting SAGE synchronization.\n');
    return 1;
  }
  if (restartService) {
    const control = new SageProjectServerConnection(
      deps.projectRoot,
      deps.config.Sage?.storage?.directory,
      { spawnIfMissing: false },
    );
    try {
      const result = await control.shutdown('operator-requested SAGE sync upgrade');
      if (!result.stopped && result.reason !== 'not-running') {
        deps.renderer.writeError(`SAGE restart failed: ${result.reason ?? 'unknown error'}\n`);
        return 1;
      }
    } finally {
      control.close();
    }
  }
  if (signal?.aborted) return 0;
  const connection = startCliHqConnection({
    clientKind: 'cli',
    projectRoot: deps.projectRoot,
    appConfig: deps.config,
    capabilities: ['telemetry.publish'],
    ownKanbanSync: false,
    ownSageSync: true,
  });
  deps.renderer.write(
    `SAGE HQ sync running for ${connection.getPublisher()?.project.projectId ?? deps.projectRoot}. Reconnect is automatic; Ctrl+C stops this bridge.\n`,
  );
  try {
    await new Promise<void>((resolve) => {
      // Keep the headless command alive while HQ is offline; publisher retry
      // timers intentionally do not keep an ordinary CLI process running.
      const keepAlive = setInterval(() => {}, 60_000);
      const stop = () => {
        clearInterval(keepAlive);
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        signal?.removeEventListener('abort', stop);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
    return 0;
  } finally {
    connection.stop();
  }
}

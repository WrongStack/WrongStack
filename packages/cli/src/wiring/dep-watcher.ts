import * as path from 'node:path';
import {
  type FileAuthorTrackerOptions,
  getSharedProjectMailbox,
  type PackageAuthorTrackerOptions,
  startPackageOutdatedWatcher,
  startTechStackConsumer,
} from '@wrongstack/core/coordination';
import type { DefaultLogger } from '@wrongstack/core/infrastructure';
import type { EventBus } from '@wrongstack/core/kernel';
import type { MultiAgentHost } from '../multi-agent.js';

interface SetupDepWatcherConsumersDeps {
  dwCfg: Record<string, unknown> | undefined;
  globalRoot: string;
  projectSlug: string;
  events: EventBus;
  multiAgentHost: MultiAgentHost;
  sessionId: string;
  logger: DefaultLogger;
  teardownHandlers: (() => void)[];
  projectRoot: string;
}

/**
 * Wire the tech-stack mailbox consumer and the package-outdated watcher.
 * Both are gated on `dwCfg?.enabled` (the file-watcher plugin's depWatcher
 * config). When enabled, the tech-stack consumer polls for dep-watcher
 * messages and spawns a subagent; the package-outdated watcher notifies
 * original authors when their added packages become outdated.
 */
export function setupDepWatcherConsumers(deps: SetupDepWatcherConsumersDeps): void {
  const {
    dwCfg,
    globalRoot,
    projectSlug,
    events,
    multiAgentHost,
    sessionId,
    logger,
    teardownHandlers,
    projectRoot,
  } = deps;

  // ── Tech-stack mailbox consumer: auto-spawn agent on dep-watcher messages ──
  let techStackConsumerDispose: (() => void) | undefined;
  if (dwCfg?.['enabled'] === true) {
    try {
      const projectDir = path.join(globalRoot, 'projects', projectSlug);
      const tsMailbox = getSharedProjectMailbox(projectDir, events);
      const fileAuthorOpts: FileAuthorTrackerOptions = {
        storageDir: projectDir,
        projectRoot,
      };
      techStackConsumerDispose = startTechStackConsumer({
        mailbox: tsMailbox,
        onSpawn: async (task, name) => {
          return multiAgentHost.spawn(task, { name, tools: ['read', 'fetch', 'mailbox'] });
        },
        targetAgent: (dwCfg['targetAgent'] as string) ?? 'tech-stack',
        consumerAgentId: 'tech-stack-consumer',
        pollIntervalMs: (dwCfg['pollIntervalMs'] as number) ?? 5000,
        fileAuthorOpts,
        sessionId,
        currentAgentId: 'leader',
        currentAgentName: 'Leader',
        onLog: (msg) => logger.debug(msg),
        onError: (err) =>
          logger.warn(
            `Tech-stack consumer error: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });
      logger.info(
        'Tech-stack mailbox consumer started — will auto-spawn agents on dependency changes',
      );
    } catch (err) {
      logger.warn(`Failed to start tech-stack consumer: ${err}`);
    }
  }

  // ── Package outdated watcher: notify original authors when packages are outdated ──
  let pkgOutdatedDispose: (() => void) | undefined;
  if (dwCfg?.['enabled'] === true) {
    try {
      const projectDir = path.join(globalRoot, 'projects', projectSlug);
      const pkgMailbox = getSharedProjectMailbox(projectDir, events);
      const pkgTrackerOpts: Pick<PackageAuthorTrackerOptions, 'storageDir' | 'projectRoot'> = {
        storageDir: projectDir,
        projectRoot,
      };
      pkgOutdatedDispose = startPackageOutdatedWatcher({
        mailbox: pkgMailbox,
        packageTrackerOpts: pkgTrackerOpts,
        pollIntervalMs: (dwCfg['pollIntervalMs'] as number) ?? 60 * 60 * 1000, // 1 hour default
        watcherAgentId: 'pkg-outdated-watcher',
        onNotify: async (msg) => {
          await pkgMailbox.send({
            from: msg.from,
            to: msg.to,
            type: 'note',
            subject: msg.subject,
            body: msg.body,
            priority: msg.priority,
          });
        },
        onLog: (m) => logger.debug(m),
        onError: (err) =>
          logger.warn(
            `Pkg-outdated-watcher error: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });
      logger.info(
        'Package outdated watcher started — will notify agents when their added packages are outdated',
      );
    } catch (err) {
      logger.warn(`Failed to start package outdated watcher: ${err}`);
    }
  }

  if (pkgOutdatedDispose) {
    teardownHandlers.push(pkgOutdatedDispose);
  }
  if (techStackConsumerDispose) {
    teardownHandlers.push(techStackConsumerDispose);
  }
}

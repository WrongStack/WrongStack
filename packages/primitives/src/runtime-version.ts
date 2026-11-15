import packageInfo from '../package.json' with { type: 'json' };

/** Bundled at build time and retained by a running process across upgrades. */
export const WRONGSTACK_RUNTIME_VERSION: string = packageInfo.version;

/** Explicit upgrade/restart succeeds only after the replacement reports our release. */
export function assertDaemonRuntimeVersion(daemonVersion: unknown): void {
  if (daemonVersion === WRONGSTACK_RUNTIME_VERSION) return;
  const actual =
    typeof daemonVersion === 'string' && daemonVersion ? daemonVersion : 'unknown (legacy)';
  throw new Error(
    `Daemon version ${actual}; expected ${WRONGSTACK_RUNTIME_VERSION}. Align the daemon and client installations before retrying restart.`,
  );
}

/**
 * Whether a client replaces the project daemon it reached: only a daemon that reports a
 * strictly older release. A daemon of the same or a newer release is reused, so installations
 * of different versions sharing a project converge on the newest daemon instead of replacing
 * each other's on every reconnect. Nothing is replaced unless both releases are a plain
 * `major.minor.patch` (a pre-release, a development build or a daemon that reports no release
 * keeps the old behaviour: reuse). `WRONGSTACK_DAEMON_REPLACE_OLDER=0` turns replacement off.
 */
export function shouldReplaceOlderDaemon(
  daemonVersion: unknown,
  clientVersion: string = WRONGSTACK_RUNTIME_VERSION,
): boolean {
  if (process.env['WRONGSTACK_DAEMON_REPLACE_OLDER'] === '0') return false;
  const client = releaseParts(clientVersion);
  if (!client) return false;
  if (typeof daemonVersion !== 'string') return false;
  const daemon = releaseParts(daemonVersion);
  if (!daemon) return false;
  for (let i = 0; i < 3; i++) {
    if (daemon[i] !== client[i]) return daemon[i]! < client[i]!;
  }
  return false;
}

function releaseParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** A release mismatch is advisory; wire compatibility is checked separately. */
export function withDaemonVersion<T extends { status: string; detail: string }>(
  service: T,
  daemonVersion: unknown,
  clientVersion = WRONGSTACK_RUNTIME_VERSION,
): T & { versionMismatch?: boolean; daemonVersion?: string } {
  if (service.status === 'offline' || service.status === 'unavailable') return service;
  const known = typeof daemonVersion === 'string' && daemonVersion.length > 0;
  if (known && daemonVersion === clientVersion) {
    return {
      ...service,
      daemonVersion,
      detail: `${service.detail} WrongStack ${daemonVersion}.`,
    };
  }
  return {
    ...service,
    // A legacy daemon reports nothing at all, so `daemonVersion` stays absent
    // rather than being filled with a placeholder the UI would render as if
    // it were a real release.
    ...(known ? { daemonVersion } : {}),
    status: service.status === 'healthy' ? 'degraded' : service.status,
    versionMismatch: true,
    detail: `${service.detail} ${known ? `Daemon WrongStack ${daemonVersion}; client ${clientVersion}. Version mismatch: align client and daemon installations, then restart the daemon from Connections.` : `Daemon version unknown (legacy); client ${clientVersion}. Restart the daemon from Connections to load the installed version.`}`,
  };
}

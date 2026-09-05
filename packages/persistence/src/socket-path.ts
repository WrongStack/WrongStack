/**
 * Unix domain socket path length validation.
 *
 * POSIX `sockaddr_un.sun_path` is a fixed-size buffer that includes the
 * terminating NUL. macOS (and other BSDs) allow 104 bytes; Linux allows 108.
 * A `bind()`/`connect()` on a longer path fails with EINVAL/ENAMETOOLONG —
 * and when the failing process is a detached daemon with `stdio: 'ignore'`,
 * the error is invisible and clients only see a connect timeout.
 *
 * Every WrongStack project daemon (codebase-index, SAGE, Kanban, mailbox,
 * chronicle) derives a deterministic socket path under the platform temp
 * directory; on macOS that directory is the ~48-character per-user
 * `/var/folders/<xx>/<30 chars>/T`, which leaves little headroom. Validate
 * endpoints at derivation time so an over-long path fails loudly (or degrades
 * explicitly) instead of timing out silently.
 */

/** Usable `sun_path` bytes (capacity minus the terminating NUL) per platform. */
export function unixSocketPathLimit(platform: NodeJS.Platform = process.platform): number {
  // macOS and the BSDs: sizeof(sun_path) == 104 including NUL.
  if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') return 103;
  // Linux and the rest of the POSIX family: 108 including NUL.
  return 107;
}

export interface UnixSocketPathCheck {
  readonly ok: boolean;
  readonly byteLength: number;
  /** Usable byte budget on this platform (NUL excluded). */
  readonly maxBytes: number;
}

/**
 * Non-throwing length check. Windows named pipes are not filesystem paths and
 * have no `sun_path` limit, so they always pass.
 */
export function checkUnixSocketPath(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): UnixSocketPathCheck {
  const maxBytes = platform === 'win32' ? Number.MAX_SAFE_INTEGER : unixSocketPathLimit(platform);
  if (typeof socketPath !== 'string' || socketPath.includes('\0')) {
    return { ok: false, byteLength: 0, maxBytes };
  }
  const byteLength = Buffer.byteLength(socketPath, 'utf8');
  if (platform === 'win32') {
    return { ok: true, byteLength, maxBytes };
  }
  return { ok: byteLength <= maxBytes, byteLength, maxBytes };
}

/**
 * Throwing variant for daemons whose endpoints are expected to always fit.
 * The error names the service and the concrete byte counts so the operator
 * can act (usually: shorten TMPDIR) instead of debugging a silent timeout.
 */
export function assertUnixSocketPathWithinLimit(
  socketPath: string,
  service: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const check = checkUnixSocketPath(socketPath, platform);
  if (check.ok) return;
  // A NUL byte (or a non-string) is not a length problem. `checkUnixSocketPath`
  // reports byteLength 0 for it, so the length message below would read "is 0
  // bytes, over the limit of 107 usable bytes" and send the operator off to
  // shorten TMPDIR, which cannot help. Name the actual defect instead.
  if (typeof socketPath !== 'string') {
    throw new Error(`${service} IPC socket path must be a string, received ${typeof socketPath}.`);
  }
  if (socketPath.includes('\u0000')) {
    throw new Error(
      `${service} IPC socket path contains a NUL byte, which no platform accepts. ` +
        `Check whatever derives this endpoint; the value is not a usable path.`,
    );
  }
  throw new Error(
    `${service} IPC socket path is ${check.byteLength} bytes, over the ${platform} ` +
      `sun_path limit of ${check.maxBytes} usable bytes: ${socketPath}. ` +
      `Set a shorter TMPDIR to relocate WrongStack IPC sockets.`,
  );
}

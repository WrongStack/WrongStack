import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const QUICK_TUNNEL_REGISTERED = /\bRegistered tunnel connection\b/i;
const START_TIMEOUT_MS = 30_000;
const MAX_LOG_CHARS = 16_384;

export interface HqQuickTunnelHandle {
  url: string;
  close(): Promise<void>;
}

interface HqQuickTunnelOptions {
  executable?: string | undefined;
  timeoutMs?: number | undefined;
  onUnexpectedExit?: ((message: string) => void) | undefined;
}

export function extractQuickTunnelUrl(output: string): string | undefined {
  return output.match(QUICK_TUNNEL_URL)?.[0];
}

/** cloudflared prints the public URL before its edge connection is usable. */
export function hasRegisteredQuickTunnelConnection(output: string): boolean {
  return QUICK_TUNNEL_REGISTERED.test(output);
}

function tail(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-MAX_LOG_CHARS);
}

/** Start an anonymous TryCloudflare tunnel and tie it to the HQ process lifecycle. */
export function startHqQuickTunnel(
  originUrl: string,
  options: HqQuickTunnelOptions = {},
): Promise<HqQuickTunnelHandle> {
  return new Promise((resolve, reject) => {
    const executable = options.executable ?? 'cloudflared';
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(executable, ['tunnel', '--url', originUrl], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let output = '';
    let settled = false;
    let closing = false;
    let publicUrl: string | undefined;

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      reject(new Error(message));
    };

    const inspect = (chunk: unknown): void => {
      output = tail(output, chunk);
      if (settled) return;
      const found = extractQuickTunnelUrl(output);
      if (found) publicUrl = found;
      if (!publicUrl || !hasRegisteredQuickTunnelConnection(output)) return;
      const readyUrl = publicUrl;
      settled = true;
      clearTimeout(timer);
      resolve({
        url: readyUrl,
        close: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            closing = true;
            const forceTimer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }, 3_000);
            child.once('exit', () => {
              clearTimeout(forceTimer);
              done();
            });
            child.kill();
          }),
      });
    };

    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error: NodeJS.ErrnoException) => {
      const detail =
        error.code === 'ENOENT'
          ? '`cloudflared` was not found in PATH. Install Cloudflare Tunnel, then retry.'
          : `cloudflared failed to start: ${error.message}`;
      fail(detail);
    });
    child.once('exit', (code, signal) => {
      const suffix = output.trim() ? `\n${output.trim()}` : '';
      if (!settled) {
        fail(
          `cloudflared exited before publishing a tunnel URL (code ${code ?? signal ?? 'unknown'}).${suffix}`,
        );
      } else if (!closing) {
        options.onUnexpectedExit?.(
          `Cloudflare Quick Tunnel ${publicUrl ?? ''} stopped (code ${code ?? signal ?? 'unknown'}).${suffix}`,
        );
      }
    });

    const timer = setTimeout(() => {
      fail(
        `${
          publicUrl
            ? 'Timed out waiting for cloudflared to register the Quick Tunnel connection.'
            : 'Timed out waiting for a trycloudflare.com URL from cloudflared.'
        }${output.trim() ? `\n${output.trim()}` : ''}`,
      );
    }, options.timeoutMs ?? START_TIMEOUT_MS);
  });
}

export function buildPublicHqUrl(
  tunnelUrl: string,
  localBrowserUrl: string | undefined,
  includeBootstrap: boolean,
): string {
  const publicUrl = new URL(tunnelUrl);
  if (includeBootstrap && localBrowserUrl) {
    // Preserve the bootstrap fragment (#bootstrap=…) from the local URL so
    // the tunnel user gets the same one-time code exchange path. Never copy
    // query-string tokens — those are the reusable credential we are
    // eliminating.
    try {
      const localHash = new URL(localBrowserUrl).hash;
      if (localHash.startsWith('#bootstrap=')) publicUrl.hash = localHash.slice(1);
    } catch {
      // Malformed local URL — skip.
    }
  }
  return publicUrl.toString();
}

import { WIN32_TREE_KILL_BUDGET_MS } from '@wrongstack/core/utils/tree-kill';
import type { MCPClientInternals } from './client-internals.js';
import { forceKillTree } from './client-process.js';
import type { MCPRequestOptions } from './client-types.js';
import type { MCPLogMessageNotification, MCPProgressNotification } from './protocol.js';
import { listAllTools } from './tool-schema.js';

/** Invoke every listener with `args`; a throwing listener never stops the rest. */
export function notifyListeners<A extends unknown[]>(
  listeners: Iterable<(...args: A) => void>,
  ...args: A
): void {
  for (const listener of listeners) {
    try {
      listener(...args);
    } catch {
      /* listeners are best-effort */
    }
  }
}

/** Body of `MCPClient.close()` — stop the stdio child, fail pending calls, close transports. */
export async function closeClient(self: MCPClientInternals): Promise<void> {
  self.toolCatalogVersion++;
  if (self.child) {
    const child = self.child;
    // Always register the listener first. Checking exitCode/signalCode
    // before registering creates a TOCTOU race: the child can exit between
    // the check and child.once('exit', ...), so the listener never fires
    // and exitPromise hangs forever. The double-check below handles the
    // case where the child already exited before we registered.
    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      if (child.exitCode !== null || child.signalCode !== null) resolve();
    });
    try {
      if (
        process.platform === 'win32' &&
        child.stdin &&
        !child.stdin.destroyed &&
        child.stdin.writable
      ) {
        // Windows launches command shims through cmd.exe. Killing that
        // wrapper does not signal the real MCP server and can orphan it
        // before tree escalation still has a live root PID. EOF on the
        // protocol stream reaches the real server and gives it the normal
        // stdio shutdown contract instead.
        child.stdin.end();
      } else {
        // POSIX children receive the conventional graceful signal directly.
        child.kill();
      }
    } catch {
      // ignore; the forced path below remains the final backstop
    }
    // Wait briefly for graceful exit, then escalate to SIGKILL. A stuck
    // server that ignores SIGTERM would otherwise stay alive after
    // close() returns — orphan child processes accumulate over restarts.
    const GRACEFUL_MS = 800;
    // Retain the Windows child until tree enumeration and its bounded
    // backstop settle; 1.2 seconds can release a still-running server.
    const FORCE_TIMEOUT_MS = process.platform === 'win32' ? WIN32_TREE_KILL_BUDGET_MS + 1000 : 1200;
    let gracefulTimer: NodeJS.Timeout | undefined;
    const gracefulRace = await Promise.race([
      exitPromise.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => {
        gracefulTimer = setTimeout(() => resolve('timeout'), GRACEFUL_MS);
        gracefulTimer.unref?.();
      }),
    ]);
    clearTimeout(gracefulTimer);
    if (gracefulRace === 'timeout') {
      // A Windows server that does not exit on stdin EOF is rooted at the
      // still-live cmd.exe wrapper, so taskkill /T /F can reliably remove
      // the complete tree. POSIX SIGKILLs the child directly.
      forceKillTree(child);
      let forceTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => {
          forceTimer = setTimeout(resolve, FORCE_TIMEOUT_MS);
          forceTimer.unref?.();
        }),
      ]);
      clearTimeout(forceTimer);
    }
    // Detach all listeners and drop the reference so the child process
    // object and its stdio streams can be garbage-collected.
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
    self.child = undefined;
  }
  // Reject pending requests BEFORE closing transports. This matters for
  // in-flight HTTP requests: they are not yet in `self.pending` (waiting
  // for a response from the network), so failPending() must run while the
  // transport is still alive. After this, the transport close is safe to
  // call even on a never-started or HTTP-only client — the exit handler
  // may have already run failPending, but calling it again with the same
  // pending set is a no-op (failPending guards on `self.pending.size`).
  self.failPending(`MCP "${self.opts.name}" closed`);
  self.serverRequests.dispose();
  // Awaited so close() resolves only once the transport has released its
  // connection pool and aborted its in-flight requests.
  await Promise.allSettled([self.sseTransport?.close(), self.httpTransport?.close()]);
  self.state = 'disconnected';
}

/** Body of `MCPClient.requestCapability()` — gate on the advertised capability, then request. */
export async function requestCapability<T>(
  self: MCPClientInternals,
  capability: 'resources' | 'prompts',
  method: string,
  params: unknown,
  parse: (value: unknown) => T,
  opts: MCPRequestOptions,
): Promise<T> {
  if (self.state !== 'connected') {
    throw new Error(`MCP client "${self.opts.name}" not connected (state=${self.state})`);
  }
  const metadata = self._serverMetadata;
  if (!metadata) {
    throw new Error(
      `MCP server "${self.opts.name}" capability metadata is unavailable for ${method}`,
    );
  }
  if (!metadata.capabilities[capability]) {
    throw new Error(
      `MCP server "${self.opts.name}" does not advertise the ${capability} capability`,
    );
  }
  const response = await self.request(method, params, undefined, opts);
  if (response.error) {
    throw new Error(`MCP ${method} failed: ${response.error.message}`);
  }
  return parse(response.result);
}

export function requireResourceSubscriptions(self: MCPClientInternals, method: string): void {
  if (self.state !== 'connected') {
    throw new Error(`MCP client "${self.opts.name}" not connected (state=${self.state})`);
  }
  if (self._serverMetadata?.capabilities.resources?.subscribe !== true) {
    throw new Error(
      `MCP server "${self.opts.name}" does not advertise resource subscriptions for ${method}`,
    );
  }
}

/**
 * L2-C: refresh the cached tool list when the server announces a
 * `tools/list_changed`. Listeners (the registry) re-wrap and
 * re-register. Failures are swallowed — a stale cache is preferable
 * to a hard crash on a transient notification glitch.
 */
export async function refreshToolsOnListChanged(self: MCPClientInternals): Promise<void> {
  const version = ++self.toolCatalogVersion;
  try {
    const tools = await listAllTools((params) => self.request('tools/list', params));
    // An error response used to normalize to [] and wipe every registered
    // tool on a transient refresh failure — keep the last catalog instead.
    if (!tools || version !== self.toolCatalogVersion) return;
    self._tools = tools;
    self._toolsCache = tools;
    self.toolCatalogRevision++;
    for (const listener of self.toolsChangedListeners) {
      if (version !== self.toolCatalogVersion) break;
      try {
        listener(self.opts.name, [...tools]);
      } catch {
        // listeners must be best-effort
      }
    }
  } catch {
    // ignore — keep the existing cache
  }
}

export function emitResourceUpdated(self: MCPClientInternals, uri: string): void {
  notifyListeners(self.resourceUpdatedListeners, self.opts.name, uri);
}

export function emitProgress(self: MCPClientInternals, progress: MCPProgressNotification): void {
  notifyListeners(self.progressListeners, self.opts.name, progress);
}

export function emitLogMessage(self: MCPClientInternals, log: MCPLogMessageNotification): void {
  notifyListeners(self.logMessageListeners, self.opts.name, log);
}

export function emitCapabilityChanged(
  self: MCPClientInternals,
  capability: 'resources' | 'prompts',
): void {
  const listeners =
    capability === 'resources' ? self.resourcesChangedListeners : self.promptsChangedListeners;
  notifyListeners(listeners, self.opts.name);
}

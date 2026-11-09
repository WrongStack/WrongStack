import type { ACPMessage } from '../types/acp-messages.js';
import type {
  PermissionOption,
  RequestPermissionOutcome,
  ToolCallId,
  ToolCallUpdateNotification,
} from '../types/acp-v1.js';
import { type FileServer, FsError } from './file-server.js';
import type { PermissionPolicy } from './permission.js';
import type { TerminalServer } from './terminal-server.js';

export interface ACPResponseSender {
  sendResult(id: string | number, result: unknown): Promise<void>;
  sendErrorResponse(id: string | number, code: number, message: string): Promise<void>;
}

export interface ACPCallbackOptions {
  /** Abort when the owning ACP session/prompt is closed or cancelled. */
  signal?: AbortSignal | undefined;
  /**
   * Maximum time to wait for callback authorization before failing closed.
   * Defaults to {@link DEFAULT_PERMISSION_TIMEOUT_MS}. Pass
   * `Number.POSITIVE_INFINITY` to opt out of the wall-clock deadline (e.g.
   * hosts whose permission policy waits for a human decision, where a short
   * cap would auto-fail approvals the user is still considering); the
   * host's `signal` still bounds the wait and fails closed on teardown.
   * Non-positive or non-finite values (other than the opt-out) fall back to
   * the fail-closed default.
   */
  permissionTimeoutMs?: number | undefined;
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;

export async function handleAcpPermissionRequest(
  msg: ACPMessage,
  permissionPolicy: PermissionPolicy,
  sender: ACPResponseSender,
  callbackOptions: ACPCallbackOptions = {},
): Promise<void> {
  const id = msg.id;
  if (id === undefined) return;
  const params = (msg as { params?: { toolCall?: unknown; options?: unknown } }).params;
  const toolCall = params?.toolCall as ToolCallUpdateNotification | undefined;
  const permissionOptions = Array.isArray(params?.options)
    ? (params.options as never as Parameters<PermissionPolicy>[0]['options'])
    : [];
  if (!toolCall) {
    await sender.sendErrorResponse(id, -32602, 'toolCall is required');
    return;
  }
  try {
    const outcome = await runPermissionWithDeadline(
      permissionPolicy,
      {
        toolCall,
        options: permissionOptions,
      },
      callbackOptions,
    );
    await sender.sendResult(id, { outcome });
  } catch (err) {
    if (isAbortLikeError(err)) {
      await sender.sendResult(id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await sender.sendErrorResponse(id, -32603, `permission policy failed: ${message}`);
  }
}

export async function handleAcpFsRequest(
  msg: ACPMessage,
  fileServer: FileServer,
  permissionPolicy: PermissionPolicy,
  sender: ACPResponseSender,
  callbackOptions: ACPCallbackOptions = {},
): Promise<void> {
  const id = msg.id;
  if (id === undefined) return;
  const params = (
    msg as {
      params?: {
        sessionId?: string;
        path?: string;
        content?: string;
        line?: number;
        limit?: number;
      };
    }
  ).params;
  if (!params?.path) {
    await sender.sendErrorResponse(id, -32602, 'path is required');
    return;
  }
  // When the file server serves paths outside the project, one that leaves it
  // (by its spelling or through a symlinked file or directory inside it) is
  // decided on where it really leads, and the read or write then goes to
  // exactly that target, so the host's sensitive-path and agent-state rules
  // see what is opened. A path inside keeps the spelling it came with: the
  // canonical form of a symlinked project root would read as outside it.
  const located = fileServer.servesOutsideRoot ? await fileServer.locate(params.path) : null;
  const target = located?.outside === true ? located.target : params.path;
  if (msg.method === 'fs/write_text_file') {
    // A missing/null content is a malformed request, not "write an empty
    // file": defaulting it to '' truncated the target once authorized.
    if (typeof params.content !== 'string') {
      await sender.sendErrorResponse(id, -32602, 'content must be a string');
      return;
    }
    const authorization = await authorizeAcpCallback(
      permissionPolicy,
      {
        toolCallId: `acp-fs-write-${id}`,
        title: `Write file: ${target}`,
        kind: 'edit',
        rawInput: { path: target, sessionId: params.sessionId },
      },
      callbackOptions,
    );
    if (authorization !== 'allowed') {
      const isCancelled = authorization === 'cancelled';
      await sender.sendErrorResponse(
        id,
        isCancelled ? -32800 : -32602,
        isCancelled
          ? 'filesystem write permission request cancelled or timed out'
          : 'filesystem write denied by permission policy',
      );
      return;
    }
  }
  // A read inside the project needs no question. One that leaves it (by its
  // spelling or through a symlink) is put to the policy as the read it is, so
  // the host's sensitive-path rules decide it: WrongStack's own `read` of
  // ~/.ssh or ~/.aws asks or refuses, and an agent's read must not skip that.
  if (msg.method === 'fs/read_text_file' && located?.outside === true) {
    const authorization = await authorizeAcpCallback(
      permissionPolicy,
      {
        toolCallId: `acp-fs-read-${id}`,
        title: `Read file outside the project: ${target}`,
        kind: 'read',
        rawInput: { path: target, sessionId: params.sessionId },
      },
      callbackOptions,
    );
    if (authorization !== 'allowed') {
      const isCancelled = authorization === 'cancelled';
      await sender.sendErrorResponse(
        id,
        isCancelled ? -32800 : -32602,
        isCancelled
          ? 'filesystem read permission request cancelled or timed out'
          : 'filesystem read outside the project denied by permission policy',
      );
      return;
    }
  }
  try {
    if (msg.method === 'fs/read_text_file') {
      const result = await fileServer.readTextFile({
        sessionId: params.sessionId ?? '',
        path: target,
        line: params.line,
        limit: params.limit,
      });
      await sender.sendResult(id, result);
    } else {
      await fileServer.writeTextFile({
        sessionId: params.sessionId ?? '',
        path: target,
        content: params.content as string,
      });
      await sender.sendResult(id, {});
    }
  } catch (err) {
    const code = err instanceof FsError ? -32602 : -32603;
    const message = err instanceof Error ? err.message : String(err);
    await sender.sendErrorResponse(id, code, message);
  }
}

export async function handleAcpTerminalRequest(
  msg: ACPMessage,
  terminalServer: TerminalServer,
  permissionPolicy: PermissionPolicy,
  sender: ACPResponseSender,
  callbackOptions: ACPCallbackOptions = {},
): Promise<void> {
  const id = msg.id;
  if (id === undefined) return;
  const params = (msg as { params?: Record<string, unknown> }).params ?? {};
  try {
    switch (msg.method) {
      case 'terminal/create': {
        // The env changes what an approved command does (GIT_CONFIG_* hooks,
        // npm_config_script_shell, BASH_ENV, …), so the permission request
        // names exactly the entries the process will receive.
        const env = Array.isArray(params.env)
          ? (params.env as unknown[]).filter(
              (entry): entry is { name: string; value: string } =>
                !!entry &&
                typeof (entry as { name?: unknown }).name === 'string' &&
                typeof (entry as { value?: unknown }).value === 'string',
            )
          : [];
        const envSuffix =
          env.length > 0 ? ` (env: ${env.map((e) => `${e.name}=${e.value}`).join(' ')})` : '';
        const authorization = await authorizeAcpCallback(
          permissionPolicy,
          {
            toolCallId: `acp-terminal-create-${id}`,
            title:
              `Run command: ${String(params.command ?? '')} ${(Array.isArray(params.args) ? params.args : []).join(' ')}`.trim() +
              envSuffix,
            kind: 'execute',
            rawInput: {
              command: params.command,
              args: params.args,
              cwd: params.cwd,
              sessionId: params.sessionId,
              ...(env.length > 0 ? { env } : {}),
            },
          },
          callbackOptions,
        );
        if (authorization !== 'allowed') {
          const isCancelled = authorization === 'cancelled';
          await sender.sendErrorResponse(
            id,
            isCancelled ? -32800 : -32602,
            isCancelled
              ? 'terminal create permission request cancelled or timed out'
              : 'terminal create denied by permission policy',
          );
          return;
        }
        const createOpts: Parameters<TerminalServer['create']>[0] = {
          sessionId: String(params.sessionId ?? ''),
          command: String(params.command ?? ''),
          args: Array.isArray(params.args) ? (params.args as string[]) : [],
        };
        if (env.length > 0) createOpts.env = env;
        if (typeof params.cwd === 'string') {
          createOpts.cwd = params.cwd;
        }
        if (typeof params.outputByteLimit === 'number') {
          createOpts.outputByteLimit = params.outputByteLimit;
        }
        const result = terminalServer.create(createOpts);
        await sender.sendResult(id, result);
        return;
      }
      case 'terminal/output': {
        const terminalId = String(params.terminalId ?? '');
        const out = terminalServer.output(terminalId);
        await sender.sendResult(id, out);
        return;
      }
      case 'terminal/wait_for_exit': {
        const terminalId = String(params.terminalId ?? '');
        const exit = await terminalServer.waitForExit(terminalId);
        await sender.sendResult(id, exit);
        return;
      }
      case 'terminal/kill': {
        const terminalId = String(params.terminalId ?? '');
        terminalServer.kill(terminalId);
        await sender.sendResult(id, {});
        return;
      }
      case 'terminal/release': {
        const terminalId = String(params.terminalId ?? '');
        terminalServer.release(terminalId);
        await sender.sendResult(id, {});
        return;
      }
      default:
        await sender.sendErrorResponse(id, -32601, `unknown method: ${msg.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sender.sendErrorResponse(id, -32603, message);
  }
}

type CallbackAuthorization = 'allowed' | 'denied' | 'cancelled';

async function authorizeAcpCallback(
  permissionPolicy: PermissionPolicy,
  partial: {
    toolCallId: string;
    title: string;
    kind: import('../types/acp-v1.js').ToolKind;
    rawInput?: Record<string, unknown>;
  },
  callbackOptions: ACPCallbackOptions,
): Promise<CallbackAuthorization> {
  try {
    const outcome = await runPermissionWithDeadline(
      permissionPolicy,
      {
        toolCall: {
          sessionUpdate: 'tool_call_update',
          toolCallId: partial.toolCallId as ToolCallId,
          title: partial.title,
          kind: partial.kind,
          status: 'pending',
          rawInput: partial.rawInput,
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
      callbackOptions,
    );
    if (outcome.outcome === 'cancelled') return 'cancelled';
    return outcome.outcome === 'selected' &&
      outcome.optionId !== 'reject' &&
      outcome.optionId !== 'reject_once' &&
      outcome.optionId !== 'reject_always'
      ? 'allowed'
      : 'denied';
  } catch (err) {
    return isAbortLikeError(err) ? 'cancelled' : 'denied';
  }
}

type PermissionCall = {
  toolCall: ToolCallUpdateNotification;
  options: readonly PermissionOption[];
};

async function runPermissionWithDeadline(
  permissionPolicy: PermissionPolicy,
  call: PermissionCall,
  callbackOptions: ACPCallbackOptions,
): Promise<RequestPermissionOutcome> {
  // `null` = explicit opt-out of the wall-clock deadline (the host's abort
  // signal still bounds the wait); no timer is scheduled in that case.
  const timeoutMs = resolvePermissionDeadline(callbackOptions.permissionTimeoutMs);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timer = timeoutMs === null ? null : setTimeout(abort, timeoutMs);
  let removeAbort: (() => void) | undefined;

  if (callbackOptions.signal) {
    if (callbackOptions.signal.aborted) {
      abort();
    } else {
      callbackOptions.signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => callbackOptions.signal?.removeEventListener('abort', abort);
    }
  }

  try {
    if (controller.signal.aborted) {
      return await rejectOnAbort(controller.signal);
    }
    return await Promise.race([
      permissionPolicy({
        toolCall: call.toolCall,
        options: call.options,
        signal: controller.signal,
      }),
      rejectOnAbort(controller.signal),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    removeAbort?.();
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = (): void => reject(new Error('permission request cancelled or timed out'));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

function isAbortLikeError(err: unknown): boolean {
  return err instanceof Error && /cancelled|canceled|timed out|aborted/i.test(err.message);
}

/**
 * Resolve the permission deadline from the caller-supplied timeout.
 * `undefined` and invalid (non-positive / non-finite) values fall back to
 * the fail-closed default; `Number.POSITIVE_INFINITY` is the explicit
 * opt-out and returns `null` (no wall-clock deadline — interactive hosts
 * whose policy waits for a human decision must not auto-fail approvals).
 */
function resolvePermissionDeadline(value: number | undefined): number | null {
  if (value === Number.POSITIVE_INFINITY) return null;
  // Node clamps setTimeout delays above 2^31-1 ms to 1 ms; cap instead.
  if (value !== undefined && Number.isFinite(value) && value > 0) {
    return Math.min(Math.trunc(value), 2_147_483_647);
  }
  return DEFAULT_PERMISSION_TIMEOUT_MS;
}

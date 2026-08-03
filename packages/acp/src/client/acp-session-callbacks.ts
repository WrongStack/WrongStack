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
  /** Maximum time to wait for callback authorization before failing closed. */
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
    const message = err instanceof Error ? err.message : String(err);
    const code = isAbortLikeError(err) ? -32800 : -32603;
    await sender.sendErrorResponse(id, code, `permission policy failed: ${message}`);
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
  const params = (msg as { params?: { sessionId?: string; path?: string; content?: string } })
    .params;
  if (!params?.path) {
    await sender.sendErrorResponse(id, -32602, 'path is required');
    return;
  }
  if (msg.method === 'fs/write_text_file') {
    const authorization = await authorizeAcpCallback(
      permissionPolicy,
      {
        toolCallId: `acp-fs-write-${id}`,
        title: `Write file: ${params.path}`,
        kind: 'edit',
        rawInput: { path: params.path, sessionId: params.sessionId },
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
  try {
    if (msg.method === 'fs/read_text_file') {
      const result = await fileServer.readTextFile({
        sessionId: params.sessionId ?? '',
        path: params.path,
      });
      await sender.sendResult(id, result);
    } else {
      await fileServer.writeTextFile({
        sessionId: params.sessionId ?? '',
        path: params.path,
        content: params.content ?? '',
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
        const authorization = await authorizeAcpCallback(
          permissionPolicy,
          {
            toolCallId: `acp-terminal-create-${id}`,
            title:
              `Run command: ${String(params.command ?? '')} ${(Array.isArray(params.args) ? params.args : []).join(' ')}`.trim(),
            kind: 'execute',
            rawInput: {
              command: params.command,
              args: params.args,
              cwd: params.cwd,
              sessionId: params.sessionId,
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
        if (Array.isArray(params.env)) {
          createOpts.env = params.env as { name: string; value: string }[];
        }
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
          ...(partial.rawInput ? { rawInput: partial.rawInput } : {}),
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
      callbackOptions,
    );
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
  const timeoutMs = finitePositiveTimeout(
    callbackOptions.permissionTimeoutMs,
    DEFAULT_PERMISSION_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
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
    return await Promise.race([
      permissionPolicy({
        toolCall: call.toolCall,
        options: call.options,
        signal: controller.signal,
      }),
      rejectOnAbort(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
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

function finitePositiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

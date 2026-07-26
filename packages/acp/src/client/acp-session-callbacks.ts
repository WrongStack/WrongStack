import type { ACPMessage } from '../types/acp-messages.js';
import type { ToolCallId, ToolCallUpdateNotification } from '../types/acp-v1.js';
import { FileServer, FsError } from './file-server.js';
import type { PermissionPolicy } from './permission.js';
import { TerminalServer } from './terminal-server.js';

export interface ACPResponseSender {
  sendResult(id: string | number, result: unknown): Promise<void>;
  sendErrorResponse(id: string | number, code: number, message: string): Promise<void>;
}

export async function handleAcpPermissionRequest(
  msg: ACPMessage,
  permissionPolicy: PermissionPolicy,
  sender: ACPResponseSender,
): Promise<void> {
  const id = msg.id;
  if (id === undefined) return;
  const params = (msg as { params?: { toolCall?: unknown; options?: unknown } }).params;
  const toolCall = params?.toolCall as ToolCallUpdateNotification | undefined;
  const options = Array.isArray(params?.options)
    ? (params.options as never as Parameters<PermissionPolicy>[0]['options'])
    : [];
  if (!toolCall) {
    await sender.sendErrorResponse(id, -32602, 'toolCall is required');
    return;
  }
  const policyAbort = new AbortController();
  try {
    const outcome = await permissionPolicy({
      toolCall,
      options,
      signal: policyAbort.signal,
    });
    await sender.sendResult(id, { outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sender.sendErrorResponse(id, -32603, `permission policy failed: ${message}`);
  }
}

export async function handleAcpFsRequest(
  msg: ACPMessage,
  fileServer: FileServer,
  permissionPolicy: PermissionPolicy,
  sender: ACPResponseSender,
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
    const allowed = await authorizeAcpCallback(permissionPolicy, {
      toolCallId: `acp-fs-write-${id}`,
      title: `Write file: ${params.path}`,
      kind: 'edit',
      rawInput: { path: params.path, sessionId: params.sessionId },
    });
    if (!allowed) {
      await sender.sendErrorResponse(id, -32602, 'filesystem write denied by permission policy');
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
): Promise<void> {
  const id = msg.id;
  if (id === undefined) return;
  const params = (msg as { params?: Record<string, unknown> }).params ?? {};
  try {
    switch (msg.method) {
      case 'terminal/create': {
        const allowed = await authorizeAcpCallback(permissionPolicy, {
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
        });
        if (!allowed) {
          await sender.sendErrorResponse(id, -32602, 'terminal create denied by permission policy');
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

async function authorizeAcpCallback(
  permissionPolicy: PermissionPolicy,
  partial: {
    toolCallId: string;
    title: string;
    kind: import('../types/acp-v1.js').ToolKind;
    rawInput?: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    const outcome = await permissionPolicy({
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
      signal: new AbortController().signal,
    });
    return (
      outcome.outcome === 'selected' &&
      outcome.optionId !== 'reject' &&
      outcome.optionId !== 'reject_once' &&
      outcome.optionId !== 'reject_always'
    );
  } catch {
    return false;
  }
}

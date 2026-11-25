import type { ACPMessage } from '../types/acp-messages.js';
import { isBestEffortAckMethod } from './acp-message-routing.js';
import { touchIdleRequests } from './acp-request-state.js';
import {
  type ACPCallbackOptions,
  type ACPResponseSender,
  handleAcpFsRequest,
  handleAcpPermissionRequest,
  handleAcpTerminalRequest,
} from './acp-session-callbacks.js';
import { ACPSessionError } from './acp-session-errors.js';
import type { ACPProgressEvent, AcpFormElicitationHandler } from './acp-session-types.js';
import { handleAcpSessionUpdate } from './acp-session-updates.js';

export interface AcpSessionMessagesHost {
  sendResult: (id: string | number, result: unknown) => Promise<void>;
  sendErrorResponse: (id: string | number, code: number, message: string) => Promise<void>;
  promptCallbackAbort: AbortController | null;
  callbackAbort: AbortController;
  pending: Map<string | number, import('./acp-request-state.js').PendingRequest>;
  sessionId: import('../types/acp-v1.js').SessionId | null;
  scratch: import('./acp-session-updates.js').ACPSessionScratch;
  emitProgress: (event: import('./acp-session-types.js').ACPProgressEvent) => void;
  permissionPolicy: import('./permission.js').PermissionPolicy;
  responseSender: () => import('./acp-session-callbacks.js').ACPResponseSender;
  callbackOptions: (msg: ACPMessage) => ACPCallbackOptions | null;
  fileServer: import('./file-server.js').FileServer;
  terminalServer: import('./terminal-server.js').TerminalServer;
  progressHandler: import('./acp-session-types.js').ACPProgressHandler | null;
  /** Agent→client requests still being answered; the turn's idle clock waits for them. */
  callbacksInFlight: number;
  elicitForm: AcpFormElicitationHandler | undefined;
  pendingElicitations: Map<string | number, AbortController>;
}

/**
 * Run an agent→client request handler while the turn's idle clock is held:
 * the agent is waiting on our answer (a human permission decision can take
 * minutes), so its silence must not stall the turn. The clock restarts when
 * the answer goes out, measuring the agent's silence from there.
 */
function trackCallback(host: AcpSessionMessagesHost, run: () => Promise<void>): void {
  host.callbacksInFlight++;
  run()
    .catch(() => {})
    .finally(() => {
      host.callbacksInFlight--;
      touchIdleRequests(host.pending);
    });
}

const ELICITATION_TIMEOUT_MS = 10 * 60_000;

async function handleElicitation(
  host: AcpSessionMessagesHost,
  msg: ACPMessage,
  options: ACPCallbackOptions,
): Promise<void> {
  if (msg.id === undefined) return;
  const id = msg.id;
  const params = msg.params as {
    mode?: unknown;
    sessionId?: unknown;
    requestId?: unknown;
    message?: unknown;
    requestedSchema?: unknown;
  } | null;
  if (!host.elicitForm || params?.mode !== 'form') {
    await host.sendErrorResponse(id, -32602, 'Elicitation mode is not available.');
    return;
  }
  const owner = options.ownerSessionId ?? host.sessionId;
  if (!owner || params.sessionId !== owner || params.requestId !== undefined) {
    await host.sendErrorResponse(id, -32602, 'Elicitation must address the active ACP session.');
    return;
  }
  if (
    typeof params.message !== 'string' ||
    !params.message.trim() ||
    params.requestedSchema === undefined
  ) {
    await host.sendErrorResponse(
      id,
      -32602,
      'An elicitation message and form schema are required.',
    );
    return;
  }
  if (host.pendingElicitations.size > 0) {
    await host.sendResult(id, { action: 'cancel' });
    return;
  }

  const cancellation = new AbortController();
  host.pendingElicitations.set(id, cancellation);
  const signal = AbortSignal.any([
    options.signal ?? host.callbackAbort.signal,
    host.callbackAbort.signal,
    cancellation.signal,
    AbortSignal.timeout(ELICITATION_TIMEOUT_MS),
  ]);
  try {
    const result = signal.aborted
      ? { action: 'cancel' as const }
      : await invokeElicitation(
          host.elicitForm,
          {
            message: params.message,
            requestedSchema: params.requestedSchema,
            ...(options.child ? { child: options.child } : {}),
          },
          signal,
        );
    if (signal.aborted) await host.sendResult(id, { action: 'cancel' });
    else if ('invalidParams' in result)
      await host.sendErrorResponse(id, -32602, result.invalidParams);
    else await host.sendResult(id, result);
  } finally {
    host.pendingElicitations.delete(id);
  }
}

async function invokeElicitation(
  handler: AcpFormElicitationHandler,
  form: Parameters<AcpFormElicitationHandler>[0],
  signal: AbortSignal,
): ReturnType<AcpFormElicitationHandler> {
  try {
    return await handler(form, signal);
  } catch {
    return { action: 'cancel' };
  }
}

export function responseSender(this: AcpSessionMessagesHost): ACPResponseSender {
  return {
    sendResult: (id, result) => this.sendResult(id, result),
    sendErrorResponse: (id, code, message) => this.sendErrorResponse(id, code, message),
  };
}

export function callbackOptions(this: AcpSessionMessagesHost): ACPCallbackOptions {
  const promptSignal = this.promptCallbackAbort?.signal;
  const signal = promptSignal
    ? AbortSignal.any([this.callbackAbort.signal, promptSignal])
    : this.callbackAbort.signal;
  return { signal, permissionTimeoutMs: Number.POSITIVE_INFINITY };
}

function dispatchCallback(
  host: AcpSessionMessagesHost,
  msg: ACPMessage,
  run: (options: ACPCallbackOptions) => Promise<void>,
): void {
  const options = host.callbackOptions(msg);
  if (!options) {
    if (msg.id !== undefined) {
      void host
        .sendErrorResponse(msg.id, -32602, 'The ACP session is not active or announced.')
        .catch(() => {});
    }
    return;
  }
  trackCallback(host, () => run(options));
}

export function handleMessage(this: AcpSessionMessagesHost, msg: ACPMessage): void {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timeoutHandle);
    this.pending.delete(msg.id);
    if (msg.error !== undefined) {
      const method = pending.method;
      const kind =
        method === 'session/new'
          ? 'session_create_failed'
          : method === 'authenticate'
            ? 'auth_failed'
            : 'protocol_error';
      pending.reject(
        new ACPSessionError(kind, msg.error.message ?? 'unknown JSON-RPC error', msg.error),
      );
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  // Anything else the agent sends (an update, a permission request, a file or
  // terminal call) shows it is still working on the turn.
  touchIdleRequests(this.pending);

  if (msg.method === 'session/update') {
    // Defense in depth. A `session/update` names the session it belongs to.
    // Our own server already drops updates for a session it closed, deleted
    // or replaced (the `emit` guard in handleSessionPromptOp), but this
    // client also speaks to third-party ACP agents that need not do the
    // same. Folding a foreign session's chunk into `scratch` splices another
    // conversation into this run's transcript — and `scratch` is what
    // prompt() returns and what the replay history is built from. Only drop
    // when the update explicitly names a DIFFERENT session, so a
    // non-conformant update that omits sessionId is still handled as before.
    const updateSessionId = (msg.params as { sessionId?: unknown } | null | undefined)?.sessionId;
    if (typeof updateSessionId === 'string' && updateSessionId !== this.sessionId) return;
    handleAcpSessionUpdate(msg, this.scratch, (event) => this.emitProgress(event));
    return;
  }

  if (msg.method === 'session/request_permission') {
    dispatchCallback(this, msg, (options) =>
      handleAcpPermissionRequest(msg, this.permissionPolicy, this.responseSender(), options),
    );
    return;
  }

  if (msg.method === 'elicitation/create') {
    dispatchCallback(this, msg, (options) => handleElicitation(this, msg, options));
    return;
  }

  if (msg.method === 'fs/read_text_file' || msg.method === 'fs/write_text_file') {
    dispatchCallback(this, msg, (options) =>
      handleAcpFsRequest(
        msg,
        this.fileServer,
        this.permissionPolicy,
        this.responseSender(),
        options,
      ),
    );
    return;
  }

  if (msg.method?.startsWith('terminal/')) {
    dispatchCallback(this, msg, (options) =>
      handleAcpTerminalRequest(
        msg,
        this.terminalServer,
        this.permissionPolicy,
        this.responseSender(),
        options,
      ),
    );
    return;
  }

  if (isBestEffortAckMethod(msg.method)) {
    if (msg.id !== undefined) {
      this.sendErrorResponse(msg.id, -32601, `Unsupported method: ${msg.method}`).catch(() => {});
    }
    return;
  }

  if (msg.method === '$/cancel_request') {
    const requestId = (msg.params as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId === 'string' || typeof requestId === 'number') {
      this.pendingElicitations.get(requestId)?.abort();
    }
    return;
  }

  if (msg.method) {
    if (msg.id !== undefined) {
      void this.sendErrorResponse(msg.id, -32601, `Unsupported method: ${msg.method}`).catch(
        () => {},
      );
      return;
    }
    // ACP extension notifications start with `_` and a receiver that does not
    // know one ignores it (Claude's adapter sends `_auth/status_update`).
    if (msg.method.startsWith('_')) return;
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'acp_session.unhandled_method',
        method: msg.method,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

export function emitProgress(this: AcpSessionMessagesHost, event: ACPProgressEvent): void {
  if (!this.progressHandler) return;
  try {
    this.progressHandler(event);
  } catch {
    // A faulty host handler must never break the wire pump.
  }
}

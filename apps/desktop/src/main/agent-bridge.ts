/**
 * Desktop Agent Bridge - WebSocket communication with runtimes.
 * Handles conversation management and WebSocket connections with automatic reconnection.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  createSurfaceConnectionState,
  DEFAULT_SURFACE_CONNECTION_CONFIG,
  decodeProtocolFrame,
  markConnectionActivity,
  markConnectionConnecting,
  markConnectionOpen,
  planConnectionReconnect,
  resetConnection,
  type SurfaceConnectionState,
  stopConnection,
} from '@wrongstack/webui-protocol';
import WebSocket from 'ws';
import type {
  DesktopConversationMessage,
  DesktopConversationSnapshot,
  DesktopConversationStatus,
} from '../shared/types.js';

// ============================================================================
// Types
// ============================================================================

interface ConversationInternal {
  runtimeId: string;
  status: DesktopConversationStatus;
  sessionId?: string | undefined;
  error?: string | undefined;
  messages: DesktopConversationMessage[];
  ws: WebSocket | null;
  connectPromise: Promise<void> | null;
  activeAssistantMessageId: string | null;
  /** Reconnection state */
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectUrl: string | null;
  connectionState: SurfaceConnectionState;
  // Per-reconnect message-handler bookkeeping. The anonymous
  // `ws.on('message', …)` pattern pins the socket + its closure (which
  // captures `conversation`) for the socket's full lifetime — fine for
  // open sockets, fatal across reconnects, where each new connect() leaks
  // a stale message listener + closure onto the previous (now-orphaned)
  // WebSocket. RAM-leak audit 2026-08-11, HIGH.
  onMessage: ((data: WebSocket.RawData) => void) | null;
  socketGeneration: number;
}

interface ServerMessage {
  type: string;
  payload?: Record<string, unknown> | undefined;
}

// ============================================================================
// Configuration
// ============================================================================

const MAX_MESSAGES = 300;

/** Reconnection configuration */
const RECONNECT_CONFIG = {
  /** Maximum number of reconnection attempts (0 = disabled) */
  maxAttempts: 5,
  /** Initial delay in ms before first reconnection */
  initialDelayMs: 1000,
  /** Maximum delay in ms between reconnection attempts */
  maxDelayMs: 30000,
  /** Multiplier for exponential backoff */
  backoffMultiplier: 2,
  /** Jitter factor (0-1) to add randomness to delays */
  jitterFactor: 0.1,
};

const DESKTOP_CONNECTION_CONFIG = {
  ...DEFAULT_SURFACE_CONNECTION_CONFIG,
  maxReconnectAttempts: RECONNECT_CONFIG.maxAttempts,
  initialBackoffMs: RECONNECT_CONFIG.initialDelayMs,
  maxBackoffMs: RECONNECT_CONFIG.maxDelayMs,
  backoffMultiplier: RECONNECT_CONFIG.backoffMultiplier,
  jitterRatio: RECONNECT_CONFIG.jitterFactor,
};

// ============================================================================
// Bridge Implementation
// ============================================================================

export class DesktopAgentBridge extends EventEmitter {
  private readonly conversations = new Map<string, ConversationInternal>();

  snapshot(runtimeId: string): DesktopConversationSnapshot {
    return publicConversation(this.getOrCreate(runtimeId));
  }

  /**
   * Get reconnection status for a runtime.
   */
  getReconnectStatus(runtimeId: string): { attempt: number; maxAttempts: number } | null {
    const conversation = this.conversations.get(runtimeId);
    if (!conversation) return null;
    return {
      attempt: conversation.reconnectAttempt,
      maxAttempts: RECONNECT_CONFIG.maxAttempts,
    };
  }

  /**
   * Force reconnection for a runtime (resets reconnection state).
   */
  forceReconnect(runtimeId: string, wsUrl: string): void {
    const conversation = this.getOrCreate(runtimeId);
    this.cancelReconnect(conversation);
    conversation.reconnectAttempt = 0;
    conversation.connectionState = resetConnection(conversation.connectionState);
    // User-triggered reconnect returns void — there is no caller to receive a
    // rejection, and connect()'s error path already records the failure state.
    // Absorb it: a dead runtime must not raise an unhandled rejection.
    void this.ensureConnected(runtimeId, wsUrl).catch(() => undefined);
  }

  async ensureConnected(runtimeId: string, wsUrl: string): Promise<DesktopConversationSnapshot> {
    const conversation = this.getOrCreate(runtimeId);

    // If already connected, return immediately
    if (conversation.ws?.readyState === WebSocket.OPEN) return publicConversation(conversation);

    // If currently connecting, wait for it
    if (conversation.connectPromise) {
      await conversation.connectPromise;
      return publicConversation(conversation);
    }

    // A user action cannot continue while only a delayed reconnect exists:
    // sendMessage() would otherwise write to a closed socket.
    if (conversation.reconnectTimer) {
      this.cancelReconnect(conversation);
      await this.connect(runtimeId, wsUrl);
      return publicConversation(conversation);
    }

    // Start fresh connection
    conversation.reconnectUrl = wsUrl;
    conversation.reconnectAttempt = 0;
    conversation.connectionState = resetConnection(conversation.connectionState);
    await this.connect(runtimeId, wsUrl);
    return publicConversation(conversation);
  }

  /**
   * Internal connect method that actually establishes the WebSocket.
   */
  private async connect(runtimeId: string, wsUrl: string): Promise<void> {
    const conversation = this.getOrCreate(runtimeId);

    // Cancel any pending reconnect timer
    this.cancelReconnect(conversation);

    conversation.status = 'connecting';
    conversation.connectionState = markConnectionConnecting(conversation.connectionState);
    conversation.error = undefined;
    this.emitChanged(conversation);
    this.emitReconnectEvent(conversation, 'connecting');

    // Store the in-flight connect promise so concurrent ensureConnected()
    // calls dedup through the conversation.connectPromise read at L129-130.
    // Without this, the dedup branch is dead and two parallel calls each
    // construct a fresh WebSocket — the loser's close-handler guard
    // (if (conversation.ws === ws)) means the superseded socket is never
    // closed, leaking one OPEN socket per race until close().
    const promise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      conversation.ws = ws;

      // Bump the generation so a message handler from this socket knows it
      // is the current one. Each connect() call gets a unique generation,
      // so a stale socket that fires a late 'message' after its successor
      // has taken over sees a mismatch and bails before touching state.
      // RAM-leak audit 2026-08-11, HIGH.
      const myGeneration = ++conversation.socketGeneration;

      // Named (not anonymous) so we can detach it in close() and in the
      // 'close' handler. An anonymous ws.on('message', …) was never removed,
      // so the closure pinned ConversationInternal (and its messages[],
      // ws, sessionId, …) until the WebSocket was GC'd — across a reconnect
      // storm this leaked every ConversationInternal that ever connected.
      // RAM-leak audit 2026-08-11, HIGH.
      const onMessage = (data: unknown): void => {
        if (conversation.socketGeneration !== myGeneration) return;
        this.handleServerMessage(conversation, String(data));
      };
      conversation.onMessage = onMessage;
      ws.on('message', onMessage);

      // Set connection timeout
      const timeout = setTimeout(() => {
        if (conversation.ws === ws) {
          ws.close();
          reject(new Error('Connection timeout'));
        }
      }, 10000);

      ws.once('open', () => {
        clearTimeout(timeout);
        conversation.status = 'connected';
        conversation.error = undefined;
        conversation.connectPromise = null;
        conversation.reconnectAttempt = 0;
        conversation.connectionState = markConnectionOpen(conversation.connectionState);
        this.emitChanged(conversation);
        this.emitReconnectEvent(conversation, 'connected');
        resolve();
      });

      ws.once('error', (err) => {
        clearTimeout(timeout);
        conversation.status = 'error';
        conversation.error = err instanceof Error ? err.message : String(err);
        conversation.connectPromise = null;
        this.appendMessage(conversation, {
          role: 'system',
          text: `Connection error: ${conversation.error}`,
        });
        this.emitChanged(conversation);
        this.emitReconnectEvent(conversation, 'error');
        reject(err);
      });

      ws.once('close', () => {
        clearTimeout(timeout);
        // Only the socket that currently owns the conversation invalidates
        // the generation — a superseded socket closing must not clobber its
        // successor's generation, or late messages from the successor would
        // be wrongly dropped. RAM-leak audit 2026-08-11, HIGH (chimera review).
        if (conversation.ws === ws) {
          conversation.socketGeneration++;
          conversation.ws = null;
        }
        // Detach our named message handler so the closure (which retains
        // conversation) is releasable even if the ws is kept alive by the
        // runtime or pending GC. RAM-leak audit 2026-08-11, HIGH.
        ws.off('message', onMessage);
        // Only clear the tracked handler if it's still ours — a newer
        // connect() may have already installed its own. Clearing
        // unconditionally would orphan the new handler's reference,
        // making it impossible for close(runtimeId) to detach it later.
        // RAM-leak audit 2026-08-11, HIGH (chimera review Medium #1).
        if (conversation.onMessage === onMessage) {
          conversation.onMessage = null;
        }
        conversation.connectPromise = null;

        if (conversation.status !== 'error') {
          conversation.status = 'disconnected';
        }
        conversation.activeAssistantMessageId = null;
        this.emitChanged(conversation);

        // Schedule reconnection if applicable
        if (
          conversation.reconnectUrl &&
          (conversation.status === 'disconnected' || conversation.status === 'error')
        ) {
          this.scheduleReconnect(conversation);
        }
      });
    });
    conversation.connectPromise = promise;
    return promise;
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(conversation: ConversationInternal): void {
    const reconnect = planConnectionReconnect(
      conversation.connectionState,
      DESKTOP_CONNECTION_CONFIG,
    );
    conversation.connectionState = reconnect.state;
    conversation.reconnectAttempt = reconnect.state.reconnectAttempt;
    if (!reconnect.plan) {
      this.emitReconnectEvent(conversation, 'exhausted');
      return;
    }
    this.emitReconnectEvent(conversation, 'scheduled', {
      delay: reconnect.plan.delayMs,
      attempt: reconnect.plan.attempt,
    });

    conversation.reconnectTimer = setTimeout(() => {
      conversation.reconnectTimer = null;
      if (!conversation.reconnectUrl) return;

      // Check if still disconnected
      if (conversation.ws?.readyState !== WebSocket.OPEN) {
        // The reconnect loop owns failure handling: connect()'s error path
        // already records status/error and schedules the next attempt (or
        // exhausts the budget). Absorb the rejection — an automatic retry
        // firing at a dead runtime must not surface as an unhandled promise
        // rejection in the Electron main process.
        void this.connect(conversation.runtimeId, conversation.reconnectUrl).catch(
          () => undefined,
        );
      }
    }, reconnect.plan.delayMs);
  }

  /**
   * Cancel pending reconnection.
   */
  private cancelReconnect(conversation: ConversationInternal): void {
    if (conversation.reconnectTimer) {
      clearTimeout(conversation.reconnectTimer);
      conversation.reconnectTimer = null;
    }
  }

  /**
   * Emit reconnection event for UI feedback.
   */
  private emitReconnectEvent(
    conversation: ConversationInternal,
    status: 'connecting' | 'connected' | 'error' | 'scheduled' | 'exhausted',
    data?: { delay?: number; attempt?: number },
  ): void {
    this.emit('reconnect', {
      runtimeId: conversation.runtimeId,
      status,
      attempt: conversation.reconnectAttempt,
      maxAttempts: RECONNECT_CONFIG.maxAttempts,
      ...data,
    });
  }

  async sendMessage(
    runtimeId: string,
    wsUrl: string,
    content: string,
  ): Promise<DesktopConversationSnapshot> {
    const trimmed = content.trim();
    if (!trimmed) return this.snapshot(runtimeId);

    // Reset reconnection state on manual action
    const conversation = this.getOrCreate(runtimeId);
    conversation.reconnectAttempt = 0;
    conversation.connectionState = resetConnection(conversation.connectionState);

    await this.ensureConnected(runtimeId, wsUrl);

    // Refresh conversation after connect
    const conv = this.getOrCreate(runtimeId);
    this.appendMessage(conv, {
      id: `user_${randomUUID()}`,
      role: 'user',
      text: trimmed,
    });
    conv.status = 'running';
    conv.activeAssistantMessageId = null;
    this.emitChanged(conv);
    this.send(conv, {
      type: 'user_message',
      payload: {
        id: `msg_${Date.now()}_${randomUUID().slice(0, 8)}`,
        content: trimmed,
        timestamp: Date.now(),
        ...(conv.sessionId ? { sessionId: conv.sessionId } : {}),
      },
    });
    return publicConversation(conv);
  }

  async abort(runtimeId: string, wsUrl: string): Promise<DesktopConversationSnapshot> {
    // Reset reconnection state on manual action
    const conversation = this.getOrCreate(runtimeId);
    conversation.reconnectAttempt = 0;
    conversation.connectionState = resetConnection(conversation.connectionState);

    await this.ensureConnected(runtimeId, wsUrl);
    const conv = this.getOrCreate(runtimeId);
    this.send(conv, {
      type: 'abort',
      payload: conv.sessionId ? { sessionId: conv.sessionId } : {},
    });
    conv.status = 'connected';
    this.appendMessage(conv, { role: 'system', text: 'Abort requested.' });
    return publicConversation(conv);
  }

  close(runtimeId: string): void {
    const conversation = this.conversations.get(runtimeId);
    if (!conversation) return;

    // Cancel reconnection and clear state
    this.cancelReconnect(conversation);
    conversation.reconnectAttempt = 0;
    conversation.reconnectUrl = null;
    conversation.connectionState = stopConnection(conversation.connectionState);

    // Detach the per-reconnect message listener BEFORE nulling the ws ref.
    // Without this, the ws.on('message', …) closure pins ConversationInternal
    // (and its messages[]) until the socket is GC'd. RAM-leak audit 2026-08-11, HIGH.
    if (conversation.onMessage) {
      conversation.ws?.off('message', conversation.onMessage);
      conversation.onMessage = null;
    }
    // Invalidate this conversation's generation so any in-flight socket whose
    // 'close' event fires after deletion cannot resurrect the conversation ref.
    conversation.socketGeneration++;
    conversation.ws?.close();
    conversation.ws = null;
    conversation.connectPromise = null;
    conversation.status = 'disconnected';
    conversation.activeAssistantMessageId = null;
    this.emitChanged(conversation);

    // Remove from the map so closed conversations don't accumulate in memory.
    this.conversations.delete(runtimeId);
  }

  closeAll(): void {
    // Snapshot keys first — close() deletes from the map during iteration.
    for (const runtimeId of [...this.conversations.keys()]) {
      this.close(runtimeId);
    }
  }

  private handleServerMessage(conversation: ConversationInternal, raw: string): void {
    const decoded = decodeProtocolFrame(raw, 'server');
    if (!decoded.ok) return;
    conversation.connectionState = markConnectionActivity(conversation.connectionState);
    const message = decoded.message as ServerMessage;
    const payload = message.payload ?? {};
    switch (message.type) {
      case 'session.start': {
        const sessionId = stringValue(payload['sessionId']);
        if (sessionId) conversation.sessionId = sessionId;
        conversation.status = conversation.status === 'running' ? 'running' : 'connected';
        this.emitChanged(conversation);
        break;
      }
      case 'provider.text_delta': {
        conversation.status = 'running';
        this.appendAssistantDelta(conversation, stringValue(payload['text']) ?? '');
        break;
      }
      case 'tool.started': {
        conversation.status = 'running';
        const name = stringValue(payload['name']) ?? 'tool';
        this.appendMessage(conversation, { role: 'tool', text: `Started ${name}` });
        break;
      }
      case 'tool.executed': {
        const name = stringValue(payload['name']) ?? 'tool';
        const ok = payload['ok'] === true;
        this.appendMessage(conversation, {
          role: 'tool',
          text: `${name} ${ok ? 'completed' : 'failed'}`,
        });
        break;
      }
      case 'provider.error':
      case 'provider.stream_error':
      case 'error': {
        const text =
          stringValue(payload['message']) ??
          stringValue(payload['description']) ??
          `${message.type} received`;
        conversation.status = 'error';
        conversation.error = text;
        this.appendMessage(conversation, { role: 'system', text });
        break;
      }
      case 'run.result': {
        const finalText = stringValue(payload['finalText']);
        // Only append the final text when this run did not already stream it
        // via text_delta into the active assistant message. Checking the
        // current run (activeAssistantMessageId) — not the last assistant
        // message in the whole history — avoids silently dropping a run whose
        // output arrives only as finalText (e.g. tool-only turns) because a
        // *prior* run's assistant message happened to have text.
        const lastMsg = conversation.messages[conversation.messages.length - 1];
        const streamedAlready =
          lastMsg?.role === 'assistant' && lastMsg.id === conversation.activeAssistantMessageId;
        if (finalText && !streamedAlready) {
          this.appendMessage(conversation, { role: 'assistant', text: finalText });
        }
        conversation.status = payload['status'] === 'failed' ? 'error' : 'connected';
        conversation.activeAssistantMessageId = null;
        this.emitChanged(conversation);
        break;
      }
    }
  }

  private send(conversation: ConversationInternal, message: Record<string, unknown>): void {
    if (conversation.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('Runtime socket is not connected');
    }
    conversation.ws.send(JSON.stringify(message));
  }

  private appendAssistantDelta(conversation: ConversationInternal, text: string): void {
    if (!text) return;
    let message = conversation.messages.find((m) => m.id === conversation.activeAssistantMessageId);
    if (!message) {
      message = {
        id: `assistant_${randomUUID()}`,
        role: 'assistant',
        text: '',
        timestamp: Date.now(),
      };
      conversation.activeAssistantMessageId = message.id;
      conversation.messages.push(message);
    }
    message.text += text;
    this.trimMessages(conversation);
    this.emitChanged(conversation);
  }

  private appendMessage(
    conversation: ConversationInternal,
    input: Partial<DesktopConversationMessage> & Pick<DesktopConversationMessage, 'role' | 'text'>,
  ): void {
    conversation.messages.push({
      id: input.id ?? `${input.role}_${randomUUID()}`,
      role: input.role,
      text: input.text,
      timestamp: input.timestamp ?? Date.now(),
    });
    this.trimMessages(conversation);
    this.emitChanged(conversation);
  }

  private trimMessages(conversation: ConversationInternal): void {
    if (conversation.messages.length <= MAX_MESSAGES) return;
    conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES);
  }

  private getOrCreate(runtimeId: string): ConversationInternal {
    let conversation = this.conversations.get(runtimeId);
    if (conversation) return conversation;
    conversation = {
      runtimeId,
      status: 'disconnected',
      messages: [],
      ws: null,
      connectPromise: null,
      activeAssistantMessageId: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      reconnectUrl: null,
      connectionState: createSurfaceConnectionState(),
      onMessage: null,
      socketGeneration: 0,
    };
    this.conversations.set(runtimeId, conversation);
    return conversation;
  }

  private emitChanged(conversation: ConversationInternal): void {
    this.emit('changed', publicConversation(conversation));
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function publicConversation(conversation: ConversationInternal): DesktopConversationSnapshot {
  return {
    runtimeId: conversation.runtimeId,
    status: conversation.status,
    sessionId: conversation.sessionId,
    error: conversation.error,
    messages: conversation.messages.map((message) => ({ ...message })),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ============================================================================
// Reconnect Event Type (for external consumers)
// ============================================================================

export interface DesktopBridgeReconnectEvent {
  runtimeId: string;
  status: 'connecting' | 'connected' | 'error' | 'scheduled' | 'exhausted';
  attempt: number;
  maxAttempts: number;
  delay?: number;
}

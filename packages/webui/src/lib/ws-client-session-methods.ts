import { safeId } from '@/lib/utils';
import type {
  WSClientMessage,
  WSModelSwitchResult,
  WSServerMessage,
  WSUserMessageImage,
} from '../types';
import type { WSSendOptions } from './ws-client-contracts';
import type { EventHandler, PendingConfirm } from './ws-client-utils';

/** Options for `sendMailboxMessage` — a mailbox message of a given intent
 *  type (btw, steer, note, …) routed to a target agent/role. Shared by the
 *  ws-client method, the `useWebSocket` wrapper, and UI prop contracts. */
export type WSMailboxSendOptions = {
  type: 'note' | 'ask' | 'assign' | 'steer' | 'btw' | 'broadcast' | 'status' | 'result' | 'review';
  to: string;
  subject: string;
  body: string;
  priority?: 'low' | 'normal' | 'high' | undefined;
  audience?: 'all' | 'leaders' | undefined;
};

export interface WsClientSessionHost {
  send(message: WSClientMessage, options?: WSSendOptions): boolean;
  withSession<T extends Record<string, unknown>>(
    payload: T,
    sessionId?: string | undefined,
  ): T & { sessionId?: string };
  on<K extends WSServerMessage['type']>(
    eventType: K,
    handler: (msg: Extract<WSServerMessage, { type: K }>) => void,
  ): () => void;
  on(eventType: string, handler: EventHandler): () => void;
  pendingConfirms: Map<string, PendingConfirm>;
  subscribedSessionIds: string[];
  replayOnNextSubscribe: boolean;
  armedResends: Map<
    string,
    {
      content: string;
      freshContext?: boolean | undefined;
      images?: WSUserMessageImage[] | undefined;
      armedAt: number;
    }
  >;
}

export interface WsClientSessionMethods {
  sendMessage(
    content: string,
    images?: WSUserMessageImage[],
    freshContext?: boolean,
    sessionId?: string | undefined,
  ): string;
  getChimeraReports(sessionId?: string | undefined): void;
  adviseTopic(
    prompt: string,
    timeoutMs?: number,
  ): Promise<Extract<WSServerMessage, { type: 'topic.advice_result' }>['payload']>;
  sendMailboxMessage(opts: WSMailboxSendOptions, sessionId?: string | undefined): string;
  sendAbort(sessionId?: string | undefined): void;
  subscribeSessions(sessionIds: string[]): void;
  clearSessionSubscription(): void;
  sendConfirm(id: string, decision: 'yes' | 'no' | 'always' | 'deny'): void;
  switchModel(
    provider: string,
    model: string,
    timeoutMs?: number,
  ): Promise<WSModelSwitchResult['payload']>;
  shutdownCodebaseIndexServer(
    timeoutMs?: number,
  ): Promise<
    Extract<WSServerMessage, { type: 'codebase.index.server.shutdown_result' }>['payload']
  >;
}

export const sessionMethods: WsClientSessionMethods = {
  sendMessage(
    this: any,
    content: string,
    images?: WSUserMessageImage[],
    freshContext = false,
    sessionId?: string | undefined,
  ): string {
    const id = `msg_${Date.now()}_${safeId().slice(0, 8)}`;
    const payload = this.withSession(
      {
        id,
        content,
        timestamp: Date.now(),
        ...(freshContext ? { freshContext: true } : {}),
        ...(images && images.length > 0 ? { images } : {}),
      },
      sessionId,
    );
    // A manual send on this session supersedes any armed auto-retry — firing
    // the parked replay after this would duplicate the user's own message.
    if (payload.sessionId) this.armedResends.delete(payload.sessionId);
    this.send({ type: 'user_message', payload });
    return id;
  },

  /** Ask the server for the persisted Chimera review reports of a session. */
  getChimeraReports(this: any, sessionId?: string | undefined): void {
    this.send({
      type: 'chimera.reports.list',
      payload: this.withSession({ sessionId: sessionId ?? '' }, sessionId),
    });
  },

  adviseTopic(
    this: any,
    prompt: string,
    timeoutMs = 10_000,
  ): Promise<Extract<WSServerMessage, { type: 'topic.advice_result' }>['payload']> {
    type Advice = Extract<WSServerMessage, { type: 'topic.advice_result' }>['payload'];
    const requestId = safeId();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Advice) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(result);
      };
      const off = (this as WsClientSessionHost).on('topic.advice_result', (message) => {
        if (message.payload.requestId !== requestId) return;
        finish(message.payload);
      });
      const timer = setTimeout(() => {
        finish({
          requestId,
          suggestNewContext: false,
          confidence: 0,
          reason: 'Topic check timed out; continuing in the current context.',
          source: 'local',
        });
      }, timeoutMs);
      this.send({
        type: 'topic.advice',
        payload: this.withSession({ requestId, prompt }),
      });
    });
  },

  /** Send a mailbox message of the given type (btw, steer, note, etc.)
   *  to a target agent/role. Returns the requestId for response tracking. */
  sendMailboxMessage(
    this: any,
    opts: WSMailboxSendOptions,
    sessionId?: string | undefined,
  ): string {
    const requestId = `mbox_${Date.now()}_${safeId().slice(0, 8)}`;
    this.send({
      type: 'mailbox.send',
      payload: this.withSession(
        {
          requestId,
          to: opts.to,
          type: opts.type,
          audience: opts.audience ?? 'all',
          subject: opts.subject,
          body: opts.body,
          priority: opts.priority ?? 'normal',
        },
        sessionId,
      ),
    });
    return requestId;
  },

  sendAbort(this: any, sessionId?: string | undefined): void {
    this.send({
      type: 'abort',
      payload: this.withSession({}, sessionId),
    });
  },

  /**
   * Tell the server every session this page is displaying.
   *
   * Four tabs share ONE socket, so the server cannot infer the open set from
   * the last message's `sessionId` — it would filter the other three tabs'
   * runs out of every broadcast, and a background tab would simply stop
   * producing output. Re-sent in full on every tab open/close (it replaces,
   * it does not merge) and re-sent on reconnect, since the server forgets the
   * set with the connection.
   */
  subscribeSessions(this: any, sessionIds: string[]): void {
    const unique = Array.from(new Set(sessionIds.filter((id) => typeof id === 'string' && id)));
    if (unique.length === 0) return;
    if (unique.length === this.subscribedSessionIds.length) {
      const same = unique.every((id, i) => id === this.subscribedSessionIds[i]);
      if (same) return;
    }
    this.subscribedSessionIds = unique;
    // The FIRST declaration on a connection asks for every tab's transcript
    // back; later ones ask for none.
    //
    // What the browser restored after a reload is a localStorage copy, and
    // that copy is capped (`MAX_PERSISTED_MESSAGES`) and carries no audit
    // markers — so a long conversation came back as its last couple of
    // hundred messages, silently, with the compaction and provider-error
    // lines missing. The journal on the server is the complete record, so the
    // page asks for it once per connection and the panes are then identical
    // to what they showed before the reload.
    //
    // Later subscribes are tab opens and closes. The one id that changed
    // already received its transcript from the `session.resume` that opened
    // it, and the tabs that did not change must NOT be re-sent one: their
    // lanes are live and a replay is the poorer record.
    const replayFor = this.replayOnNextSubscribe ? unique : [];
    this.replayOnNextSubscribe = false;
    this.send({
      type: 'session.subscribe',
      payload: this.withSession({
        sessionIds: unique,
        ...(replayFor.length > 0 ? { replayFor } : {}),
      }),
    });
  },

  /** Forget the declared set so the next call re-sends it (used on reconnect). */
  clearSessionSubscription(this: any): void {
    this.subscribedSessionIds = [];
    // A fresh connection means the panes may be showing a stale or truncated
    // localStorage copy: ask for the journal again with the re-declaration.
    this.replayOnNextSubscribe = true;
  },

  sendConfirm(this: any, id: string, decision: 'yes' | 'no' | 'always' | 'deny'): void {
    if (this.pendingConfirms.has(id)) {
      this.pendingConfirms.delete(id);
    }
    this.send({
      type: 'tool.confirm_result',
      payload: this.withSession({ id, decision }),
    });
  },

  switchModel(
    this: any,
    provider: string,
    model: string,
    timeoutMs = 8_000,
  ): Promise<WSModelSwitchResult['payload']> {
    const requestId = safeId();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: WSModelSwitchResult['payload']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(result);
      };
      const off = (this as WsClientSessionHost).on('model.switch_result', (msg) => {
        const payload = (msg as WSModelSwitchResult).payload;
        if (payload.requestId !== requestId) return;
        finish(payload);
      });
      const timer = setTimeout(() => {
        finish({
          requestId,
          success: false,
          message: 'Model switch timed out. Please try again.',
          provider,
          model,
          runActive: false,
        });
      }, timeoutMs);
      this.send({
        type: 'model.switch',
        payload: this.withSession({ provider, model, requestId }),
      });
    });
  },

  shutdownCodebaseIndexServer(
    this: any,
    timeoutMs = 8_000,
  ): Promise<
    Extract<WSServerMessage, { type: 'codebase.index.server.shutdown_result' }>['payload']
  > {
    type ShutdownResult = Extract<
      WSServerMessage,
      { type: 'codebase.index.server.shutdown_result' }
    >['payload'];
    const requestId = safeId();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ShutdownResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(result);
      };
      const off = (this as WsClientSessionHost).on(
        'codebase.index.server.shutdown_result',
        (message) => {
          if (message.payload.requestId && message.payload.requestId !== requestId) return;
          finish(message.payload);
        },
      );
      const timer = setTimeout(() => {
        finish({
          requestId,
          stopped: false,
          reason: 'Codebase index server shutdown timed out.',
        });
      }, timeoutMs);
      const sent = this.send(
        { type: 'codebase.index.server.shutdown', payload: { requestId } },
        { queueIfDisconnected: false },
      );
      if (!sent) {
        finish({
          requestId,
          stopped: false,
          reason: 'WebSocket is not connected.',
        });
      }
    });
  },
};

export function installWsClientSessionMethods(ctor: { prototype: any }): void {
  Object.assign(ctor.prototype, sessionMethods);
}

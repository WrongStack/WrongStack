import type { AcpChildSession } from '@wrongstack/contracts/types/acp-runtime';
import { sanitizeTerminalPreview } from '@wrongstack/core/utils';
import { extractText, isRecord } from './acp-session-content.js';
import type { AcpChildSource } from './acp-session-types.js';

const MAX_TRACKED_CHILDREN = 256;
const MAX_ID_CHARS = 500;
const MAX_OUTPUT_CHARS = 4_000;

function preview(value: unknown, maxChars: number, maxLines = 20): string {
  return typeof value === 'string'
    ? sanitizeTerminalPreview(value, { maxChars, maxLines }).text
    : '';
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
}

export class AcpChildSessions {
  private readonly children = new Map<
    string,
    { view: AcpChildSession; work: AbortController; messageId?: string | undefined }
  >();

  constructor(readonly rootId: string) {}

  list(): AcpChildSession[] {
    return structuredClone([...this.children.values()].map((child) => child.view));
  }

  has(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  source(sessionId: string): { child: AcpChildSource; signal: AbortSignal } | undefined {
    const child = this.children.get(sessionId);
    return (
      child && {
        child: { id: sessionId, title: child.view.title },
        signal: child.work.signal,
      }
    );
  }

  close(): void {
    for (const child of this.children.values()) child.work.abort();
    this.children.clear();
  }

  /** Returns true for updates handled outside the parent transcript. */
  receive(ownerId: string, update: Record<string, unknown>, historical: boolean): boolean {
    if (update.sessionUpdate === 'subagent_update') {
      this.announce(ownerId, update, historical);
      return true;
    }
    const child = this.children.get(ownerId);
    if (
      update.sessionUpdate === 'session_message' ||
      update.sessionUpdate === 'session_message_chunk'
    ) {
      const peerId =
        ownerId === this.rootId
          ? update.senderSessionId === ownerId
            ? update.recipientSessionId
            : update.senderSessionId
          : undefined;
      const destination =
        child ?? (typeof peerId === 'string' ? this.children.get(peerId) : undefined);
      if (destination) this.recordMessage(destination, update);
      return true;
    }
    if (!child) return false;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = preview(extractText(update.content), MAX_OUTPUT_CHARS);
      child.view.output = (child.view.output + text).slice(-MAX_OUTPUT_CHARS);
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      const title = preview(update.title, 300, 1);
      if (title) child.view.activity = title;
    }
    return true;
  }

  private announce(parentId: string, update: Record<string, unknown>, historical: boolean): void {
    const childId = update.sessionId;
    if (
      !id(childId) ||
      childId === this.rootId ||
      childId === parentId ||
      (parentId !== this.rootId && !this.children.has(parentId))
    )
      return;
    let entry = this.children.get(childId);
    if (entry && entry.view.parentId !== parentId) return;
    if (!entry) {
      if (this.children.size >= MAX_TRACKED_CHILDREN) return;
      entry = {
        view: {
          id: childId,
          parentId,
          title: null,
          description: null,
          state: 'unconfirmed',
          stopReason: null,
          output: '',
        },
        work: new AbortController(),
      };
      this.children.set(childId, entry);
    }
    const { view } = entry;
    if (update.title === null || typeof update.title === 'string')
      view.title = preview(update.title, 300, 1) || null;
    if (update.description === null || typeof update.description === 'string')
      view.description = preview(update.description, 1_000) || null;
    if (historical || update.state === undefined) return;
    const state = isRecord(update.state) ? update.state : undefined;
    view.state = preview(state?.state, 60, 1) || 'unconfirmed';
    view.stopReason = view.state === 'idle' ? preview(state?.stopReason, 60, 1) || null : null;
    if (view.state === 'idle' && view.stopReason === 'cancelled') entry.work.abort();
    if ((view.state === 'running' || view.state === 'requires_action') && entry.work.signal.aborted)
      entry.work = new AbortController();
  }

  private recordMessage(
    child: { view: AcpChildSession; messageId?: string | undefined },
    update: Record<string, unknown>,
  ): void {
    const blocks = Array.isArray(update.content) ? update.content.slice(0, 32) : [update.content];
    const text = preview(blocks.map(extractText).join(''), MAX_OUTPUT_CHARS);
    if (!text) return;
    const messageId = id(update.messageId) ? update.messageId : undefined;
    const senderId = id(update.senderSessionId) ? update.senderSessionId : null;
    const previous = child.view.message;
    const append =
      update.sessionUpdate === 'session_message_chunk' &&
      messageId &&
      child.messageId === messageId;
    child.view.message = {
      senderId: senderId ?? (append ? (previous?.senderId ?? null) : null),
      text: append ? ((previous?.text ?? '') + text).slice(-MAX_OUTPUT_CHARS) : text,
    };
    child.messageId = messageId;
  }
}

/**
 * Regression: an unscoped TelegramInbox.acknowledge() must not clear other
 * chats' buffered mail.
 *
 * Telegram `message_id` is a per-chat counter — ids are ordered only inside
 * one chat and are never comparable across chats. acknowledge() used to drop
 * every buffered message with `messageId <= lastMessageId` across ALL chats
 * when no `chatId` was passed, so the documented telegram_read → ack_last
 * pattern (read newest-first across all chats, ack the highest id seen)
 * silently destroyed mail from other chats — including messages the agent
 * never saw because of `limit` truncation.
 *
 * Fixed 2026-09-06: an unscoped ack only clears the chat(s) that actually
 * contain a buffered message with the anchor id. Single-chat deployments
 * keep byte-identical behavior (the one chat owns the anchor).
 */
import { describe, expect, it } from 'vitest';
import { TelegramInbox, type TelegramInboxDeps } from '../../src/inbox.js';

function makeDeps(): TelegramInboxDeps {
  return {
    log: { debug: () => {} },
    bufferMax: 100,
    allowedUsers: new Set<string>(),
    allowedChats: new Set<string>(),
    onMessage: () => {},
    sendNotice: async () => ({}),
  } as unknown as TelegramInboxDeps;
}

type ApiMsg = Parameters<TelegramInbox['processMessage']>[0];

function mk(chatId: number, messageId: number, text: string): ApiMsg {
  return {
    message_id: messageId,
    date: 1_757_136_000,
    chat: { id: chatId, type: 'private' },
    from: { id: 42, username: 'alice' },
    text,
  } as ApiMsg;
}

const key = (m: { chatId: string | number; messageId: number }): string =>
  `${m.chatId}:${m.messageId}`;

describe('TelegramInbox.acknowledge cross-chat scoping', () => {
  it("an unscoped ack of chat A's highest id leaves chat B's (never-displayed) mail buffered", () => {
    const inbox = new TelegramInbox(makeDeps());
    inbox.processMessage(mk(222, 3, 'b-3'));
    inbox.processMessage(mk(222, 4, 'b-4'));
    inbox.processMessage(mk(111, 500, 'a-500'));

    // Documented read: newest-first across all chats, truncated — 222:3 is
    // never displayed to the agent.
    expect(inbox.getMessages({ limit: 2 }).map(key)).toEqual(['111:500', '222:4']);

    // Documented ack: the highest message_id seen, no chat scope.
    expect(inbox.acknowledge(500)).toBe(1);
    expect(inbox.getMessages({ limit: 50 }).map(key)).toEqual(['222:4', '222:3']);

    // Chat B is cleared through its OWN anchor id (within-chat range).
    expect(inbox.acknowledge(4)).toBe(2);
    expect(inbox.getMessages({ limit: 50 })).toEqual([]);
  });

  it('single-chat deployment keeps identical semantics (the one chat owns the anchor)', () => {
    const inbox = new TelegramInbox(makeDeps());
    inbox.processMessage(mk(333, 10, 'x'));
    inbox.processMessage(mk(333, 20, 'y'));
    expect(inbox.acknowledge(20)).toBe(2);
    expect(inbox.getMessages({ limit: 50 })).toEqual([]);
  });

  it('explicit chat-scoped ack clears only that chat (unchanged path)', () => {
    const inbox = new TelegramInbox(makeDeps());
    inbox.processMessage(mk(444, 5, 'p'));
    inbox.processMessage(mk(555, 5, 'q'));
    expect(inbox.acknowledge(5, 555)).toBe(1);
    expect(inbox.getMessages({ limit: 50 }).map(key)).toEqual(['444:5']);
  });

  it('an anchor id absent from the buffer clears nothing (safe direction)', () => {
    const inbox = new TelegramInbox(makeDeps());
    inbox.processMessage(mk(666, 7, 'z'));
    expect(inbox.acknowledge(999)).toBe(0);
    expect(inbox.getMessages({ limit: 50 }).map(key)).toEqual(['666:7']);
  });

  it("when two chats both hold the anchor id, each chat's within-chat range is cleared", () => {
    // Per-chat counters collide easily (both chats have a message 5). The
    // anchor names a message in both chats, so each is cleared up to and
    // including its own id 5 — strictly narrower than the old global sweep
    // and never wider than an explicit per-chat ack.
    const inbox = new TelegramInbox(makeDeps());
    inbox.processMessage(mk(444, 4, 'p4'));
    inbox.processMessage(mk(444, 5, 'p5'));
    inbox.processMessage(mk(555, 3, 'q3'));
    inbox.processMessage(mk(555, 5, 'q5'));
    expect(inbox.acknowledge(5)).toBe(4);
    expect(inbox.getMessages({ limit: 50 })).toEqual([]);
  });
});

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMailboxStore, isUnreadIncomingMailboxMessage } from '../src/lib/mailbox-store.js';

describe('SimpleUI mailbox store — extended coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isUnreadIncomingMailboxMessage', () => {
    it('returns true for an unread, incomplete message from a real agent', () => {
      expect(
        isUnreadIncomingMailboxMessage({ completed: false, readByCount: 0, from: 'worker@x' }),
      ).toBe(true);
    });
    it('returns false for a completed message', () => {
      expect(
        isUnreadIncomingMailboxMessage({ completed: true, readByCount: 0, from: 'worker@x' }),
      ).toBe(false);
    });
    it('returns false when readByCount > 0', () => {
      expect(
        isUnreadIncomingMailboxMessage({ completed: false, readByCount: 1, from: 'worker@x' }),
      ).toBe(false);
    });
    it('returns false for empty from', () => {
      expect(isUnreadIncomingMailboxMessage({ completed: false, readByCount: 0, from: '' })).toBe(
        false,
      );
    });
    it('returns false for webui self-messages', () => {
      expect(
        isUnreadIncomingMailboxMessage({ completed: false, readByCount: 0, from: 'webui' }),
      ).toBe(false);
    });
    it('returns false for simpleui self-messages', () => {
      expect(
        isUnreadIncomingMailboxMessage({ completed: false, readByCount: 0, from: 'simpleui' }),
      ).toBe(false);
    });
  });

  describe('applyMessage — mailbox.messages with unreadOnly filter', () => {
    it('sets unreadCount from filtered messages when unreadOnly=true', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.messages',
        payload: {
          unreadOnly: true,
          messages: [
            { id: 'm1', from: 'worker@x', completed: false, readByCount: 0 },
            { id: 'm2', from: 'webui', completed: false, readByCount: 0 },
            { id: 'm3', from: 'worker@y', completed: true, readByCount: 0 },
          ],
        },
      });
      // Only m1 is unread-incoming (m2 is self, m3 is completed)
      expect(store.getSnapshot().unreadCount).toBe(1);
    });

    it('replaces messages when unreadOnly is not set', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.messages',
        payload: {
          messages: [
            { id: 'm1', from: 'worker@x', completed: false, readByCount: 0 },
            { id: 'm2', from: 'webui', completed: true, readByCount: 1 },
          ],
        },
      });
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(2);
      expect(snap.unreadCount).toBe(0); // unchanged
    });
  });

  describe('applyMessage — mailbox.agents', () => {
    it('stores parsed agents', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.agents',
        payload: {
          agents: [
            { agentId: 'leader@x', name: 'Leader', status: 'running', online: true },
            { agentId: 'worker@x', name: 'Worker', role: 'executor', status: 'idle', online: true },
          ],
        },
      });
      const agents = store.getSnapshot().agents;
      expect(agents).toHaveLength(2);
      expect(agents[0].name).toBe('Leader');
      expect(agents[1].role).toBe('executor');
    });

    it('sets error from payload', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.agents',
        payload: { agents: [], error: 'IPC timeout' },
      });
      expect(store.getSnapshot().error).toBe('IPC timeout');
    });

    it('clears error when no error field', () => {
      const store = createMailboxStore();
      store.applyMessage({ type: 'mailbox.agents', payload: { agents: [], error: 'old' } });
      store.applyMessage({ type: 'mailbox.agents', payload: { agents: [] } });
      expect(store.getSnapshot().error).toBeNull();
    });
  });

  describe('applyMessage — event types that trigger refresh', () => {
    it('stamps lastEventAt and calls onRefreshNeeded for mailbox.received', () => {
      const refresh = vi.fn();
      const store = createMailboxStore(refresh);
      store.applyMessage({ type: 'mailbox.received', payload: {} });
      expect(store.getSnapshot().lastEventAt).toBe(Date.now());
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('stamps lastEventAt and calls onRefreshNeeded for mailbox.action_result', () => {
      const refresh = vi.fn();
      const store = createMailboxStore(refresh);
      store.applyMessage({ type: 'mailbox.action_result', payload: {} });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('stamps lastEventAt and calls onRefreshNeeded for mailbox.agent_registered', () => {
      const refresh = vi.fn();
      const store = createMailboxStore(refresh);
      store.applyMessage({ type: 'mailbox.agent_registered', payload: {} });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('stamps lastEventAt and calls onRefreshNeeded for mailbox.event', () => {
      const refresh = vi.fn();
      const store = createMailboxStore(refresh);
      store.applyMessage({ type: 'mailbox.event', payload: {} });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('stamps lastEventAt and calls onRefreshNeeded for mailbox.sent', () => {
      const refresh = vi.fn();
      const store = createMailboxStore(refresh);
      store.applyMessage({ type: 'mailbox.sent', payload: {} });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('returns false for event types (not accepted as primary data)', () => {
      const store = createMailboxStore();
      expect(store.applyMessage({ type: 'mailbox.sent', payload: {} })).toBe(false);
      expect(store.applyMessage({ type: 'mailbox.received', payload: {} })).toBe(false);
    });

    it('returns true for primary data types', () => {
      const store = createMailboxStore();
      expect(store.applyMessage({ type: 'mailbox.messages', payload: { messages: [] } })).toBe(
        true,
      );
      expect(store.applyMessage({ type: 'mailbox.agents', payload: { agents: [] } })).toBe(true);
    });
  });

  describe('applyMessage — unknown message types', () => {
    it('returns false and does not modify state', () => {
      const store = createMailboxStore();
      const before = store.getSnapshot();
      const result = store.applyMessage({ type: 'unknown.type', payload: {} });
      expect(result).toBe(false);
      expect(store.getSnapshot()).toEqual(before);
    });
  });

  describe('applyMessage — lastEventAt', () => {
    it('is null before any message arrives', () => {
      const store = createMailboxStore();
      expect(store.getSnapshot().lastEventAt).toBeNull();
    });

    it('is set after a primary data message', () => {
      const store = createMailboxStore();
      store.applyMessage({ type: 'mailbox.messages', payload: { messages: [] } });
      expect(store.getSnapshot().lastEventAt).toBe(Date.now());
    });

    it('updates on each message', () => {
      const store = createMailboxStore();
      vi.setSystemTime(new Date('2026-07-28T12:00:01.000Z'));
      store.applyMessage({ type: 'mailbox.messages', payload: { messages: [] } });
      const t1 = store.getSnapshot().lastEventAt;
      vi.setSystemTime(new Date('2026-07-28T12:00:05.000Z'));
      store.applyMessage({ type: 'mailbox.received', payload: {} });
      const t2 = store.getSnapshot().lastEventAt;
      expect(t2).toBeGreaterThan(t1!);
    });
  });

  describe('subscribe / getSnapshot', () => {
    it('notifies listeners on state change', () => {
      const store = createMailboxStore();
      const listener = vi.fn();
      const unsub = store.subscribe(listener);
      store.applyMessage({ type: 'mailbox.messages', payload: { messages: [] } });
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
      store.applyMessage({ type: 'mailbox.messages', payload: { messages: [] } });
      expect(listener).toHaveBeenCalledTimes(1); // not called after unsub
    });

    it('getSnapshot returns stable reference between changes', () => {
      const store = createMailboxStore();
      const snap1 = store.getSnapshot();
      // No message applied — snapshot should be the same reference
      const snap2 = store.getSnapshot();
      expect(snap1).toBe(snap2);
    });
  });

  describe('message cap enforcement', () => {
    it('caps retained messages at 100', () => {
      const store = createMailboxStore();
      const messages = Array.from({ length: 120 }, (_, i) => ({
        id: `m-${i}`,
        from: 'worker@x',
        completed: false,
        readByCount: 0,
      }));
      store.applyMessage({ type: 'mailbox.messages', payload: { messages } });
      expect(store.getSnapshot().messages).toHaveLength(100);
    });

    it('caps retained agents at 50', () => {
      const store = createMailboxStore();
      const agents = Array.from({ length: 60 }, (_, i) => ({
        agentId: `agent-${i}`,
        name: `Agent ${i}`,
        status: 'idle',
        online: true,
      }));
      store.applyMessage({ type: 'mailbox.agents', payload: { agents } });
      expect(store.getSnapshot().agents).toHaveLength(50);
    });
  });

  describe('parseMessages defensive parsing', () => {
    it('drops entries without an id', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.messages',
        payload: {
          messages: [{ id: '', from: 'x' }, { from: 'y' }, { id: 'good', from: 'z' }],
        },
      });
      expect(store.getSnapshot().messages).toHaveLength(1);
      expect(store.getSnapshot().messages[0].id).toBe('good');
    });

    it('defaults priority to normal when missing', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.messages',
        payload: { messages: [{ id: 'm1', from: 'x' }] },
      });
      expect(store.getSnapshot().messages[0].priority).toBe('normal');
    });

    it('computes readByCount from readBy object when readByCount is absent', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.messages',
        payload: {
          messages: [{ id: 'm1', from: 'x', readBy: { a: true, b: true } }],
        },
      });
      expect(store.getSnapshot().messages[0].readByCount).toBe(2);
    });
  });

  describe('parseAgents defensive parsing', () => {
    it('drops entries without an agentId', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.agents',
        payload: {
          agents: [{ name: 'no-id' }, { agentId: 'good', name: 'Has ID' }],
        },
      });
      expect(store.getSnapshot().agents).toHaveLength(1);
      expect(store.getSnapshot().agents[0].agentId).toBe('good');
    });

    it('defaults status to idle when missing', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.agents',
        payload: { agents: [{ agentId: 'a1', name: 'A' }] },
      });
      expect(store.getSnapshot().agents[0].status).toBe('idle');
    });

    it('defaults name to agentId when missing', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.agents',
        payload: { agents: [{ agentId: 'a1' }] },
      });
      expect(store.getSnapshot().agents[0].name).toBe('a1');
    });

    it('defaults online to false when not explicitly true', () => {
      const store = createMailboxStore();
      store.applyMessage({
        type: 'mailbox.agents',
        payload: { agents: [{ agentId: 'a1', online: 'yes' }] },
      });
      expect(store.getSnapshot().agents[0].online).toBe(false);
    });
  });
});

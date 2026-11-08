// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationNotice } from '../src/conversation-notices';
import { NotificationMenu } from '../src/NotificationMenu';
import { notificationAge, notificationStore, notificationView } from '../src/notification-center';
import { forwardConversationNotice, sessionTransition } from '../src/notification-feed';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Where the window keeps its notification history. */
const NOTIFICATIONS_KEY = 'wrongstack.desktop.notifications';
const messages = () => notificationStore.get().notifications.map((n) => n.message);

describe('the notification history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    notificationStore.clear();
    notificationStore.setFilter('important');
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the newest first, drops a quick repeat and stops at the limit', () => {
    notificationStore.push({ message: 'one', variant: 'info' });
    vi.setSystemTime(1_001_000);
    notificationStore.push({ message: 'two', variant: 'error' });
    expect(messages()).toEqual(['two', 'one']);
    // The same report within five seconds is one event; later it is a new one.
    vi.setSystemTime(1_002_000);
    notificationStore.push({ message: 'two', variant: 'error' });
    expect(messages()).toEqual(['two', 'one']);
    vi.setSystemTime(1_009_000);
    notificationStore.push({ message: 'two', variant: 'error' });
    notificationStore.push({ message: '  ', variant: 'info' });
    expect(messages()).toEqual(['two', 'two', 'one']);
    for (let i = 0; i < 105; i++) notificationStore.push({ message: `m${i}`, variant: 'info' });
    expect(messages()).toHaveLength(100);
    expect(messages()[0]).toBe('m104');
  });

  it('filters by type, marks read and clears', () => {
    notificationStore.push({ message: 'ok', variant: 'success' });
    notificationStore.push({ message: 'bad', variant: 'error' });
    notificationStore.push({ message: 'careful', variant: 'warn' });
    const id = (message: string) =>
      notificationStore.get().notifications.find((n) => n.message === message)!.id;
    const view = (tab: 'all' | 'unread') => notificationView(notificationStore.get(), tab);
    // "Important" is warnings and errors.
    expect(view('all').rows.map((n) => n.message)).toEqual(['careful', 'bad']);
    notificationStore.setFilter('all');
    expect(view('all').scoped).toHaveLength(3);
    notificationStore.setFilter('success');
    expect(view('all').rows.map((n) => n.message)).toEqual(['ok']);
    notificationStore.setFilter('important');
    notificationStore.markRead(id('bad'));
    expect(view('unread').rows.map((n) => n.message)).toEqual(['careful']);
    expect(view('all').unread).toBe(1);
    notificationStore.markAllRead();
    expect(notificationStore.get().notifications.every((n) => n.read)).toBe(true);
    notificationStore.remove(id('careful'));
    expect(messages()).toEqual(['bad', 'ok']);
    notificationStore.clear();
    expect(messages()).toEqual([]);
    expect(notificationStore.get().filter).toBe('important');
  });

  it('reads a saved history and drops anything malformed', () => {
    localStorage.setItem(NOTIFICATIONS_KEY, '{not json');
    notificationStore.reload();
    expect(notificationStore.get()).toEqual({ notifications: [], filter: 'important' });
    localStorage.setItem(
      NOTIFICATIONS_KEY,
      JSON.stringify({
        filter: 'error',
        notifications: [
          { id: 'a', message: 'kept', variant: 'error', timestamp: 5, read: false },
          { id: 'b', message: 'bad variant', variant: 'fatal', timestamp: 5, read: false },
          { id: 'c', message: 'no time', variant: 'info', read: true },
        ],
      }),
    );
    notificationStore.reload();
    expect(notificationStore.get().filter).toBe('error');
    expect(messages()).toEqual(['kept']);
    localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify({ filter: 'nope', notifications: 3 }));
    notificationStore.reload();
    expect(notificationStore.get()).toEqual({ notifications: [], filter: 'important' });
  });

  it('says how long ago in whole units', () => {
    const say = (key: string, count?: number) => `${key.split('.').at(-1)}:${count ?? ''}`;
    const now = 10 * 86_400_000;
    expect(notificationAge(now - 3000, say, now)).toBe('justNow:');
    expect(notificationAge(now - 42_000, say, now)).toBe('secondsAgo:42');
    expect(notificationAge(now - 5 * 60_000, say, now)).toBe('minutesAgo:5');
    expect(notificationAge(now - 3 * 3_600_000, say, now)).toBe('hoursAgo:3');
    expect(notificationAge(now - 2 * 86_400_000, say, now)).toBe('daysAgo:2');
  });
});

describe('what reaches the history', () => {
  beforeEach(() => notificationStore.clear());

  it('tells a failure, an interruption and a finished live conversation, nothing else', () => {
    expect(sessionTransition(undefined, 'error')).toBeNull();
    expect(sessionTransition('running', 'running')).toBeNull();
    expect(sessionTransition('running', 'error')).toEqual({ key: 'failed', variant: 'error' });
    expect(sessionTransition('running', 'interrupted')).toEqual({
      key: 'interrupted',
      variant: 'warn',
    });
    expect(sessionTransition('starting', 'stopped')).toEqual({
      key: 'stopped',
      variant: 'success',
    });
    expect(sessionTransition('error', 'stopped')).toBeNull();
    expect(sessionTransition('stopped', 'running')).toBeNull();
  });

  it('forwards a live warning or a passing notice once, never an old replayed one', () => {
    const notice = (over: Partial<ConversationNotice>): ConversationNotice => ({
      id: 'n1',
      severity: 'warning',
      text: 'Compaction failed',
      hint: '',
      at: Date.now() + 1000,
      ...over,
    });
    expect(forwardConversationNotice(notice({}), 'Compaction failed')).toBe(true);
    expect(forwardConversationNotice(notice({}), 'Compaction failed')).toBe(false);
    expect(forwardConversationNotice(notice({ id: 'old', at: 1 }), 'old')).toBe(false);
    expect(forwardConversationNotice(notice({ id: 'i', severity: 'info' }), 'info')).toBe(false);
    expect(
      forwardConversationNotice(
        notice({ id: 't', severity: 'info', transient: true, at: 1 }),
        'tip',
      ),
    ).toBe(true);
    expect(notificationStore.get().notifications.map((n) => [n.message, n.variant])).toEqual([
      ['tip', 'info'],
      ['Compaction failed', 'warn'],
    ]);
    expect(JSON.parse(localStorage.getItem(NOTIFICATIONS_KEY) ?? '{}').notifications).toHaveLength(
      2,
    );
  });
});

describe('the bell’s notification menu', () => {
  let root: Root;
  const host = document.createElement('div');
  const onAttention = vi.fn();
  async function render(attention = 0) {
    await act(async () => root.render(createElement(NotificationMenu, { attention, onAttention })));
  }
  const buttons = () => [...host.querySelectorAll('button')];
  const press = (text: string) =>
    act(async () =>
      buttons()
        .find((button) => button.textContent?.includes(text))
        ?.click(),
    );

  beforeEach(async () => {
    await surfaceI18n.changeLanguage('en');
    notificationStore.clear();
    notificationStore.setFilter('important');
    document.body.append(host);
    root = createRoot(host);
  });
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('counts unread reports of the chosen type, filters, marks read and clears', async () => {
    await render(2);
    expect(host.querySelector('[data-testid="notification-badge"]')).toBeNull();
    expect(host.textContent).toContain('No notifications');
    await act(async () => {
      notificationStore.push({ message: 'Engine crashed', variant: 'error' });
      notificationStore.push({ message: 'Saved the file', variant: 'success' });
    });
    expect(host.querySelector('[data-testid="notification-badge"]')?.textContent).toBe('1');
    expect(host.textContent).toContain('Engine crashed');
    expect(host.textContent).not.toContain('Saved the file');
    const select = host.querySelector('select')!;
    await act(async () => {
      select.value = 'all';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('Saved the file');
    expect(host.querySelector('[data-testid="notification-badge"]')?.textContent).toBe('2');
    await press('Unread (2)');
    await press('Mark all as read');
    expect(host.querySelector('[data-testid="notification-badge"]')).toBeNull();
    expect(host.textContent).toContain('All caught up');
    await press('All (2)');
    await press('Clear all');
    expect(notificationStore.get().notifications).toEqual([]);
    expect(host.textContent).toContain('No notifications');
    // The conversations needing attention stay reachable from the bell.
    await press('2 conversations need attention');
    expect(onAttention).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('marks one read and removes one, in Turkish too', async () => {
    await surfaceI18n.changeLanguage('tr');
    await render();
    await act(async () => {
      notificationStore.push({ message: 'first', variant: 'warn' });
      notificationStore.push({ message: 'second', variant: 'error' });
    });
    expect(host.textContent).toContain('Bildirimler');
    const markRead = host.querySelector<HTMLButtonElement>('button[aria-label="Okundu say"]')!;
    await act(async () => markRead.click());
    expect(notificationStore.get().notifications.find((n) => n.message === 'second')?.read).toBe(
      true,
    );
    const remove = host.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Bildirimi kaldır"]',
    );
    await act(async () => remove[1]!.click());
    expect(notificationStore.get().notifications.map((n) => n.message)).toEqual(['second']);
    act(() => root.unmount());
  });
});

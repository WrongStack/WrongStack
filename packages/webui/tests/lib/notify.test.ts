// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type NotificationRecord = {
  title: string;
  options?: NotificationOptions;
  closed: boolean;
};

function installNotificationMock(permission: NotificationPermission) {
  const records: NotificationRecord[] = [];

  class MockNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    onclick: (() => void) | null = null;
    private record: NotificationRecord;

    constructor(title: string, options?: NotificationOptions) {
      this.record = { title, options, closed: false };
      records.push(this.record);
    }

    close() {
      this.record.closed = true;
    }
  }

  vi.stubGlobal('Notification', MockNotification);
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: MockNotification,
  });
  return { MockNotification, records };
}

describe('ensureNotificationPermission', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'default' },
    });
  });

  it('requests permission lazily and caches the result', async () => {
    const MockNotification = {
      permission: 'default',
      requestPermission: vi.fn(async () => 'granted'),
    };
    vi.stubGlobal('Notification', MockNotification);

    const { ensureNotificationPermission } = await import('@/lib/notify');

    await expect(ensureNotificationPermission()).resolves.toBe('granted');
    await expect(ensureNotificationPermission()).resolves.toBe('granted');
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('returns the cached state immediately when already granted', async () => {
    const requestPermissionSpy = vi.fn();
    vi.stubGlobal('Notification', {
      permission: 'granted',
      requestPermission: requestPermissionSpy,
    });

    const { ensureNotificationPermission } = await import('@/lib/notify');

    await expect(ensureNotificationPermission()).resolves.toBe('granted');
    expect(requestPermissionSpy).not.toHaveBeenCalled();
  });

  it('returns denied without calling requestPermission when already denied', async () => {
    const requestPermissionSpy = vi.fn();
    vi.stubGlobal('Notification', {
      permission: 'denied',
      requestPermission: requestPermissionSpy,
    });

    const { ensureNotificationPermission } = await import('@/lib/notify');

    await expect(ensureNotificationPermission()).resolves.toBe('denied');
    expect(requestPermissionSpy).not.toHaveBeenCalled();
  });

  it('returns denied when requestPermission throws', async () => {
    const MockNotification = {
      permission: 'default',
      requestPermission: vi.fn(async () => {
        throw new Error('Permission request failed');
      }),
    };
    vi.stubGlobal('Notification', MockNotification);

    const { ensureNotificationPermission } = await import('@/lib/notify');

    // Line 37: catch branch — requestPermission threw
    await expect(ensureNotificationPermission()).resolves.toBe('denied');
  });
});

describe('notifyIfHidden', () => {
  it('does not notify while the tab is visible', async () => {
    const { records } = installNotificationMock('granted');
    const { notifyIfHidden } = await import('@/lib/notify');

    notifyIfHidden('Done', 'Visible tab');

    expect(records).toHaveLength(0);
  });

  it('creates a tagged notification only when hidden and granted', async () => {
    const { records } = installNotificationMock('granted');
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    vi.resetModules();
    const { notifyIfHidden } = await import('@/lib/notify');

    notifyIfHidden('Approval needed', 'Tool is waiting', 'wrongstack-confirm');

    expect(records).toEqual([
      expect.objectContaining({
        title: 'Approval needed',
        options: expect.objectContaining({
          body: 'Tool is waiting',
          tag: 'wrongstack-confirm',
          requireInteraction: true,
        }),
      }),
    ]);
  });

  it('does not create a notification when permission is denied', async () => {
    const { records } = installNotificationMock('denied');
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    vi.resetModules();
    const { notifyIfHidden } = await import('@/lib/notify');

    notifyIfHidden('Done', 'Result');

    expect(records).toHaveLength(0);
  });

  it('silently swallows Notification constructor errors', async () => {
    // Some browsers (e.g. iOS Safari) throw from the Notification constructor.
    // The catch in notify.ts swallows these without propagating.
    class ThrowingNotification {
      static permission = 'granted' as NotificationPermission;
      static requestPermission = vi.fn();
      constructor() {
        throw new Error('Notification not supported');
      }
    }
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: ThrowingNotification as never as typeof Notification,
    });

    const { notifyIfHidden } = await import('@/lib/notify');

    // Should not throw — the catch in notify.ts swallows it
    expect(() => notifyIfHidden('Title', 'Body')).not.toThrow();
  });

  it('onclick calls n.close on the notification instance', async () => {
    // Capture the Notification instance directly in the constructor so we can
    // call its onclick handler after notifyIfHidden has replaced it.
    const closeSpy = vi.fn();
    let captured: { onclick: (() => void) | null } | null = null;

    class ClickableNotification {
      static permission = 'granted' as NotificationPermission;
      static requestPermission = vi.fn();
      onclick: (() => void) | null = null;

      constructor(_title: string, _options?: NotificationOptions) {
        captured = this;
        this.onclick = () => {
          closeSpy();
        };
      }

      close() {
        closeSpy();
      }
    }

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    vi.stubGlobal('Notification', ClickableNotification);
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: ClickableNotification,
    });
    vi.resetModules();

    const { notifyIfHidden } = await import('@/lib/notify');
    closeSpy.mockClear(); // clear the constructor-call close

    notifyIfHidden('Done', 'Result');

    // notifyIfHidden set n.onclick = () => { window.focus(); n.close(); }
    // This REPLACED our constructor's onclick. Verify closeSpy NOT called yet.
    expect(closeSpy).not.toHaveBeenCalled();

    // Simulate OS click — fire the handler notifyIfHidden set
    captured!.onclick?.();

    // Now closeSpy should have been called (via n.close() inside onclick)
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Tests for src/lib/desktop-host.ts — Desktop-shell bridge helpers.
 * These helpers are no-ops when window.wrongstackDesktopHost is absent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_COMMAND_DOCKS,
  DESKTOP_COMMAND_VIEWS,
  DESKTOP_COMMAND_WORK_TABS,
  publishDesktopCommandAck,
  publishDesktopPrefsSnapshot,
  publishDesktopReady,
} from '../../src/lib/desktop-host';
import { useLocalPrefs } from '../../src/stores/local-prefs';

describe('constants', () => {
  it('DESKTOP_COMMAND_VIEWS contains all view names', () => {
    expect(DESKTOP_COMMAND_VIEWS.has('chat')).toBe(true);
    expect(DESKTOP_COMMAND_VIEWS.has('settings')).toBe(true);
    expect(DESKTOP_COMMAND_VIEWS.has('analytics')).toBe(true);
    expect(DESKTOP_COMMAND_VIEWS.has('sddhub')).toBe(true);
    expect(DESKTOP_COMMAND_VIEWS.has('sddboard')).toBe(false);
    expect(DESKTOP_COMMAND_VIEWS.has('sddwizard')).toBe(false);
    expect(DESKTOP_COMMAND_VIEWS.has('specs')).toBe(false);
    expect(DESKTOP_COMMAND_VIEWS.has('history')).toBe(true);
    expect(DESKTOP_COMMAND_VIEWS.size).toBe(17);
  });

  it('DESKTOP_COMMAND_DOCKS contains dock section names', () => {
    expect(DESKTOP_COMMAND_DOCKS.has('goal')).toBe(true);
    expect(DESKTOP_COMMAND_DOCKS.has('fleet')).toBe(true);
    expect(DESKTOP_COMMAND_DOCKS.size).toBe(5);
  });

  it('DESKTOP_COMMAND_WORK_TABS contains work tab names', () => {
    expect(DESKTOP_COMMAND_WORK_TABS.has('todos')).toBe(true);
    expect(DESKTOP_COMMAND_WORK_TABS.has('tasks')).toBe(true);
    expect(DESKTOP_COMMAND_WORK_TABS.has('plan')).toBe(true);
    expect(DESKTOP_COMMAND_WORK_TABS.size).toBe(3);
  });
});

describe('publishDesktopPrefsSnapshot', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    vi.restoreAllMocks();
  });

  it('is a no-op when window is undefined (SSR)', () => {
    (globalThis as any).window = undefined;
    // Should not throw
    expect(() => publishDesktopPrefsSnapshot()).not.toThrow();
  });

  it('is a no-op when wrongstackDesktopHost is absent', () => {
    (globalThis as any).window = { ...originalWindow };
    expect(() => publishDesktopPrefsSnapshot()).not.toThrow();
  });

  it('is a no-op when setPrefs is absent', () => {
    (globalThis as any).window = {
      ...originalWindow,
      wrongstackDesktopHost: {},
    };
    expect(() => publishDesktopPrefsSnapshot()).not.toThrow();
  });

  it('calls setPrefs with current prefs when host is available', () => {
    const setPrefs = vi.fn();
    (globalThis as any).window = {
      ...originalWindow,
      wrongstackDesktopHost: { setPrefs },
    };

    // Set some prefs to verify they're passed through
    useLocalPrefs.setState({ yolo: true, nextPrediction: false, contextAutoCompact: true });
    publishDesktopPrefsSnapshot();

    expect(setPrefs).toHaveBeenCalledTimes(1);
    expect(setPrefs).toHaveBeenCalledWith({
      yolo: true,
      nextPrediction: false,
      contextAutoCompact: true,
    });
  });
});

describe('publishDesktopReady', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  it('is a no-op when window is undefined', () => {
    (globalThis as any).window = undefined;
    expect(() => publishDesktopReady(true)).not.toThrow();
  });

  it('is a no-op when host is absent', () => {
    (globalThis as any).window = { ...originalWindow };
    expect(() => publishDesktopReady(true)).not.toThrow();
  });

  it('calls setReady when host is available', () => {
    const setReady = vi.fn();
    (globalThis as any).window = {
      ...originalWindow,
      wrongstackDesktopHost: { setReady },
    };
    publishDesktopReady(true);
    expect(setReady).toHaveBeenCalledWith(true);
  });

  it('works when host has no methods', () => {
    (globalThis as any).window = {
      ...originalWindow,
      wrongstackDesktopHost: {},
    };
    expect(() => publishDesktopReady(false)).not.toThrow();
  });
});

describe('publishDesktopCommandAck', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  it('is a no-op when window is undefined', () => {
    (globalThis as any).window = undefined;
    expect(() => publishDesktopCommandAck('req-1', true)).not.toThrow();
  });

  it('is a no-op when requestId is not a string', () => {
    (globalThis as any).window = {
      ...originalWindow,
      wrongstackDesktopHost: { ackCommand: vi.fn() },
    };
    // Should return early without calling ackCommand
    (globalThis as any).window.wrongstackDesktopHost.ackCommand = vi.fn();
    publishDesktopCommandAck(123, true);
    expect((globalThis as any).window.wrongstackDesktopHost.ackCommand).not.toHaveBeenCalled();
  });

  it('calls ackCommand when host is available', () => {
    const ackCommand = vi.fn();
    (globalThis as any).window = {
      ...originalWindow,
      wrongstackDesktopHost: { ackCommand },
    };
    publishDesktopCommandAck('req-1', true, 'completed');
    expect(ackCommand).toHaveBeenCalledWith('req-1', true, 'completed');
  });

  it('is a no-op when ackCommand is absent', () => {
    (globalThis as any).window = {
      ...originalWindow,
      wrongstackDesktopHost: {},
    };
    expect(() => publishDesktopCommandAck('req-1', true)).not.toThrow();
  });

  it('handles undefined message', () => {
    const ackCommand = vi.fn();
    (globalThis as any).window = {
      ...originalWindow,
      wrongstackDesktopHost: { ackCommand },
    };
    publishDesktopCommandAck('req-1', false, undefined);
    expect(ackCommand).toHaveBeenCalledWith('req-1', false, undefined);
  });
});

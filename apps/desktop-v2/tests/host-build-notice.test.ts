// @vitest-environment jsdom
/**
 * After an update the session host keeps running conversations on the previous build's engine.
 * The window offers to restart it only on confirmation, and an engine notice that would tell
 * the user to update an application that is already current points at the restart instead.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationNotice } from '../src/conversation-notices';
import { desktopVersion, setDesktopVersion, versionAtLeast } from '../src/desktop-version';

const platform = vi.hoisted(() => ({ hostInfo: vi.fn(), restartHost: vi.fn() }));
vi.mock('../src/platform', () => ({ native: true, ...platform }));

const { HostBuildNotice } = await import('../src/HostBuildNotice');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('desktop version', () => {
  it('compares stable releases and refuses anything else', () => {
    expect(versionAtLeast('1.7.1', '1.7.1')).toBe(true);
    expect(versionAtLeast('1.7.1', 'v1.6.3')).toBe(true);
    expect(versionAtLeast('1.10.0', '1.9.9')).toBe(true);
    expect(versionAtLeast('1.6.3', '1.7.1')).toBe(false);
    expect(versionAtLeast('1.7.1', '1.8.0-rc.1')).toBe(false);
    expect(versionAtLeast('dev', '1.0.0')).toBe(false);
  });
});

describe('engine release notice', () => {
  afterEach(() => setDesktopVersion(undefined));
  const start = { appVersion: '1.6.3', latestVersion: '1.7.1', updateAvailable: true };

  it('points at the engine restart when the application is already at the release', () => {
    setDesktopVersion('1.7.1');
    const notice = conversationNotice('session.start', start, 'n1', 0);
    expect(notice?.text).toBe('This conversation runs on engine 1.6.3; this app is 1.7.1.');
    expect(notice?.hint).toContain('Restart engine');
    expect(notice?.hint).not.toContain('wstack desktop update');
  });

  it('still suggests the update when the application itself is older', () => {
    setDesktopVersion('1.6.3');
    expect(conversationNotice('session.start', start, 'n1', 0)?.hint).toContain(
      'wstack desktop update',
    );
  });
});

describe('HostBuildNotice', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    platform.hostInfo.mockReset();
    platform.restartHost.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setDesktopVersion(undefined);
  });
  const mount = async () => {
    await act(async () => root.render(createElement(HostBuildNotice)));
  };
  const button = (name: RegExp) =>
    [...host.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));

  it('shows nothing when the host runs this build, and learns the application version', async () => {
    platform.hostInfo.mockResolvedValue({ appVersion: '1.7.1', stale: false });
    await mount();
    expect(host.textContent).toBe('');
    expect(desktopVersion()).toBe('1.7.1');
  });

  it('restarts the engine only after the user confirms', async () => {
    platform.hostInfo.mockResolvedValue({ appVersion: '1.7.1', stale: true });
    platform.restartHost.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(host.textContent).toContain('earlier WrongStack Desktop');
    await act(async () => button(/^Restart engine$/)?.click());
    expect(platform.restartHost).not.toHaveBeenCalled();
    expect(host.textContent).toContain('stop gracefully');

    await act(async () => button(/Cancel/)?.click());
    expect(button(/Restart now/)).toBeUndefined();

    await act(async () => button(/^Restart engine$/)?.click());
    await act(async () => button(/Restart now/)?.click());
    expect(platform.restartHost).toHaveBeenCalledTimes(1);
    expect(button(/Restarting/)?.disabled).toBe(true);
  });

  it('says why a restart failed and offers it again', async () => {
    platform.hostInfo.mockResolvedValue({ appVersion: '1.7.1', stale: true });
    platform.restartHost.mockRejectedValue('These conversations did not stop: a');
    await mount();
    await act(async () => button(/^Restart engine$/)?.click());
    await act(async () => button(/Restart now/)?.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('did not stop: a');
    expect(button(/^Restart engine$/)).toBeDefined();
  });
});

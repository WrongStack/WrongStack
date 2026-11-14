// @vitest-environment jsdom
/**
 * The desktop update notice: offered only for a newer release the user has not put off,
 * Install & restart where the build installs itself and a download link elsewhere, and
 * choices kept in this window's storage (an older session host refuses unknown registry
 * settings).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  noticeFor,
  readUpdatePrefs,
  UPDATE_PREFS_KEY,
  type UpdateStatus,
  writeUpdatePrefs,
} from '../src/update-notice';

const platform = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock('../src/platform', () => ({ native: true, ...platform }));

const { UpdateNotice } = await import('../src/UpdateNotice');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: '1.7.0',
  version: '1.7.1',
  releaseUrl: 'https://github.com/WrongStack/WrongStack/releases/tag/v1.7.1',
  canInstall: true,
  ...patch,
});

describe('update notice model', () => {
  it('offers only a newer version that was not put off, while checks are on', () => {
    expect(noticeFor(status(), { enabled: true })).toEqual({
      version: '1.7.1',
      releaseUrl: status().releaseUrl,
      canInstall: true,
    });
    expect(noticeFor(status({ version: null }), { enabled: true })).toBeNull();
    expect(noticeFor(status(), { enabled: true, dismissed: '1.7.1' })).toBeNull();
    expect(
      noticeFor(status({ version: '1.7.2' }), { enabled: true, dismissed: '1.7.1' }),
    ).not.toBeNull();
    expect(noticeFor(status(), { enabled: false })).toBeNull();
    expect(noticeFor(undefined, { enabled: true })).toBeNull();
  });

  it('reads damaged or missing choices as the default and writes them back', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(readUpdatePrefs(storage)).toEqual({ enabled: true });
    store.set(UPDATE_PREFS_KEY, '{broken');
    expect(readUpdatePrefs(storage)).toEqual({ enabled: true });
    writeUpdatePrefs(storage, { enabled: false, dismissed: '1.7.1' });
    expect(readUpdatePrefs(storage)).toEqual({ enabled: false, dismissed: '1.7.1' });
    expect(readUpdatePrefs(undefined)).toEqual({ enabled: true });
    expect(() =>
      writeUpdatePrefs(
        {
          setItem: () => {
            throw new Error('quota');
          },
        },
        { enabled: true },
      ),
    ).not.toThrow();
  });
});

describe('UpdateNotice', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    for (const fn of Object.values(platform)) fn.mockReset();
    platform.installUpdate.mockResolvedValue(undefined);
    platform.openExternal.mockResolvedValue(undefined);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const mount = async () => {
    await act(async () => root.render(createElement(UpdateNotice)));
  };
  /** A button by its text or, for an icon button, its label. */
  const button = (name: RegExp) =>
    [...host.querySelectorAll('button')].find(
      (b) => name.test(b.textContent ?? '') || name.test(b.getAttribute('aria-label') ?? ''),
    );

  it('installs where the build installs itself and says conversations keep running', async () => {
    platform.checkForUpdate.mockResolvedValue(status());
    await mount();
    expect(host.textContent).toContain('WrongStack Desktop 1.7.1 is available');
    expect(host.textContent).toContain('conversations keep running');
    await act(async () => button(/Install & restart/)?.click());
    expect(platform.installUpdate).toHaveBeenCalledTimes(1);
    expect(button(/Installing/)?.disabled).toBe(true);
  });

  it('links to the release where the build cannot install it (Linux, no key)', async () => {
    platform.checkForUpdate.mockResolvedValue(status({ canInstall: false }));
    await mount();
    expect(button(/Install/)).toBeUndefined();
    await act(async () => button(/Download/)?.click());
    expect(platform.openExternal).toHaveBeenCalledWith(status().releaseUrl);
  });

  it('puts a version off with Later and shows nothing for an up-to-date build', async () => {
    platform.checkForUpdate.mockResolvedValue(status());
    await mount();
    await act(async () => button(/Later/)?.click());
    expect(host.textContent).toBe('');
    expect(readUpdatePrefs(localStorage).dismissed).toBe('1.7.1');

    act(() => root.unmount());
    root = createRoot(host);
    platform.checkForUpdate.mockResolvedValue(status({ version: null }));
    await mount();
    expect(host.textContent).toBe('');
  });

  it('does not check at all once checks are turned off', async () => {
    localStorage.setItem(UPDATE_PREFS_KEY, JSON.stringify({ enabled: false }));
    await mount();
    expect(platform.checkForUpdate).not.toHaveBeenCalled();
  });

  it('shows why an install failed and lets the user try again', async () => {
    platform.checkForUpdate.mockResolvedValue(status());
    platform.installUpdate.mockRejectedValue('signature mismatch');
    await mount();
    await act(async () => button(/Install & restart/)?.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('signature mismatch');
    expect(button(/Install & restart/)?.disabled).toBe(false);
  });
});

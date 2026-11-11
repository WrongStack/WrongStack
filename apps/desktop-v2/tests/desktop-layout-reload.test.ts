// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Snapshot } from '../src/model';
import { type DesktopController, useDesktop } from '../src/useDesktop';

const bridge = vi.hoisted(() => ({ request: vi.fn(), snapshot: vi.fn(), key: 'layout' }));
vi.mock('../src/platform', () => ({
  native: true,
  request: bridge.request,
  getSnapshot: bridge.snapshot,
  get layoutKey() {
    return bridge.key;
  },
}));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setZoom: async () => {} }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const sessions: Session[] = ['alpha', 'beta'].map((id) => ({
  id,
  projectId: `p-${id}`,
  title: id,
  kind: 'agent',
  workdir: `/repo/${id}`,
  status: 'stopped',
  createdAt: 1,
  updatedAt: 1,
  exitCode: null,
  error: null,
}));
const layout = (selected: string) =>
  JSON.stringify({
    selected,
    project: `p-${selected}`,
    openSessionIds: ['beta', 'alpha'],
    section: 'fleet',
    projectPage: 'overview',
  });
let hostLayout: string;
let held: { value: string; finish: (error?: Error) => void }[];
let hold: boolean;
let root: Root | undefined;
let host: HTMLDivElement;
let desktop: DesktopController;
function Probe() {
  desktop = useDesktop();
  return createElement('output', null, desktop.selected);
}
async function mount() {
  root = createRoot(host);
  await act(async () => root!.render(createElement(Probe)));
  expect(desktop.connected).toBe(true);
}
async function reload() {
  await act(async () => root!.unmount());
  root = undefined;
  await mount();
}
async function select(id: string) {
  await act(async () => desktop.jumpToSession(sessions.find((row) => row.id === id)!));
  expect(desktop.selected).toBe(id);
  expect(desktop.getDraft(id)).toBe(`private ${id} draft`);
}
async function tick() {
  await act(async () => vi.advanceTimersByTimeAsync(400));
}

describe('desktop selection across a window reload', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, '', '/');
    bridge.key = 'layout';
    hostLayout = layout('beta');
    held = [];
    hold = false;
    bridge.snapshot.mockImplementation(
      async (): Promise<Snapshot> => ({
        projects: sessions.map((row) => ({
          id: row.projectId,
          name: row.title,
          root: row.workdir,
          createdAt: 1,
        })),
        sessions,
        hostPid: 1,
        layout: hostLayout,
      }),
    );
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'draft.get')
        return {
          text: `private ${params.id} draft`,
          references: [],
          attachments: [],
          mode: 'btw',
          revisions: { text: 0, references: 0, attachments: 0, mode: 0 },
        };
      if (method !== 'settings.save') throw Error(`Unexpected native request: ${method}`);
      const value = params.value as string;
      if (!hold) {
        hostLayout = value;
        return null;
      }
      return new Promise((resolve, reject) =>
        held.push({
          value,
          finish: (error) => {
            if (error) reject(error);
            else {
              hostLayout = value;
              resolve(null);
            }
          },
        }),
      );
    });
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    bridge.request.mockReset();
    bridge.snapshot.mockReset();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('restores a host-acknowledged selection and keeps drafts with their owners', async () => {
    await mount();
    await select('alpha');
    await tick();
    await reload();
    expect(desktop.selected).toBe('alpha');
    expect(desktop.project).toBe('p-alpha');
    expect(desktop.openSessionIds).toEqual(['beta', 'alpha']);
    expect(desktop.getDraft('alpha')).toBe('private alpha draft');
    await select('beta');
    expect(desktop.getDraft('beta')).toBe('private beta draft');
  });

  it('restores the visible selection when reloaded before its debounce fires', async () => {
    await mount();
    await select('alpha');
    expect(JSON.parse(hostLayout).selected).toBe('beta');
    await reload();
    expect(desktop.selected).toBe('alpha');
    expect(desktop.project).toBe('p-alpha');
    expect(desktop.getDraft('alpha')).toBe('private alpha draft');
  });

  it('restores the selection while its native save is explicitly held', async () => {
    await mount();
    hold = true;
    await select('alpha');
    await tick();
    expect(held).toHaveLength(1);
    expect(JSON.parse(hostLayout).selected).toBe('beta');
    await reload();
    expect(desktop.selected).toBe('alpha');
    expect(desktop.getDraft('alpha')).toBe('private alpha draft');
    await act(async () => held[0]!.finish());
    expect(desktop.selected).toBe('alpha');
  });

  it('does not let an older save acknowledgement erase a newer selection', async () => {
    await mount();
    hold = true;
    await select('alpha');
    await tick();
    await select('beta');
    await act(async () => held[0]!.finish());
    expect(JSON.parse(hostLayout).selected).toBe('alpha');
    await reload();
    expect(desktop.selected).toBe('beta');
    expect(desktop.project).toBe('p-beta');
    expect(desktop.getDraft('beta')).toBe('private beta draft');
  });

  it('retains the latest selection for reload after a native save failure', async () => {
    await mount();
    hold = true;
    await select('alpha');
    await tick();
    await act(async () => held[0]!.finish(Error('Test-owned settings write failure')));
    expect(desktop.error).toContain('Test-owned settings write failure');
    await reload();
    expect(desktop.selected).toBe('alpha');
  });

  it('uses the host again after the matching pending save is acknowledged', async () => {
    await mount();
    await select('alpha');
    await tick();
    hostLayout = layout('beta');
    await reload();
    expect(desktop.selected).toBe('beta');
  });

  it('keeps pending main-window and project-window layouts separate', async () => {
    await mount();
    await select('alpha');
    bridge.key = 'layout:p-beta';
    history.replaceState(null, '', '/?project=p-beta');
    await reload();
    expect(desktop.project).toBe('p-beta');
    expect(desktop.selected).toBeNull();
    bridge.key = 'layout';
    history.replaceState(null, '', '/');
    await reload();
    expect(desktop.selected).toBe('alpha');
    expect(desktop.getDraft('alpha')).toBe('private alpha draft');
  });

  it('still saves through the host when session storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw Error('Denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('Denied');
    });
    await mount();
    await select('alpha');
    await tick();
    await reload();
    expect(desktop.selected).toBe('alpha');
    expect(desktop.error).toBe('');
  });
});

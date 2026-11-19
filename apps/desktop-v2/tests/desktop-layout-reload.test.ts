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

  it.each(['draft validation', 'the first draft read'] as const)(
    'appends a project request to the latest text when %s is pending',
    async (phase) => {
      const request = bridge.request.getMockImplementation()!;
      let release!: () => void;
      const validation = new Promise<void>((resolve) => {
        release = resolve;
      });
      let start!: () => void;
      const validating = new Promise<void>((resolve) => {
        start = resolve;
      });
      let firstRead = true;
      let revision = 0;
      let savedText = 'private alpha draft';
      bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === 'draft.revisions') {
          if (phase === 'draft validation') {
            start();
            await validation;
          }
          return { text: revision, references: 0, attachments: 0, mode: 0 };
        }
        if (
          phase === 'the first draft read' &&
          method === 'draft.get' &&
          params.id === 'alpha' &&
          firstRead
        ) {
          firstRead = false;
          const old = await request(method, params);
          start();
          await validation;
          return old;
        }
        if (method === 'draft.save') {
          expect(params.id).toBe('alpha');
          expect(params.expectedRevision).toBe(revision);
          savedText = String(params.text);
          return { revision: ++revision };
        }
        return request(method, params);
      });
      await mount();
      if (phase === 'draft validation') await select('alpha');

      let prepared!: Promise<boolean>;
      await act(async () => {
        prepared = desktop.prepareProjectRequest('p-alpha', 'alpha', 'Prepared project request');
        await validating;
      });
      if (phase === 'the first draft read') await select('alpha');
      await act(async () => {
        expect(await desktop.setDraft('alpha', 'My newer unsent edit')).toBe(true);
      });
      expect(savedText).toBe('My newer unsent edit');
      await act(async () => {
        release();
        expect(await prepared).toBe(true);
      });
      expect(desktop.getDraft('alpha')).toBe('My newer unsent edit\n\nPrepared project request');
      expect(savedText).toBe(desktop.getDraft('alpha'));
    },
  );

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

  it('clears a removed project and its tabs after a refresh without deleting owned drafts', async () => {
    await mount();
    await select('alpha');
    await act(async () => desktop.openProjectPage('p-alpha'));
    bridge.snapshot.mockResolvedValue({
      projects: [{ id: 'p-beta', name: 'beta', root: '/repo/beta', createdAt: 1 }],
      sessions: sessions.filter((s) => s.id === 'beta'),
      hostPid: 1,
      layout: hostLayout,
    });
    await act(async () => desktop.run(async () => {}));
    expect(desktop.project).toBeNull();
    expect(desktop.selected).toBeNull();
    expect(desktop.section).toBe('fleet');
    expect(desktop.openSessionIds).toEqual(['beta']);
    expect(desktop.getDraft('alpha')).toBe('private alpha draft');
  });

  it.each(['move', 'remove', 'stale error'] as const)(
    'keeps the action refresh when a periodic snapshot completes later (%s)',
    async (kind) => {
      await mount();
      const original = desktop.snapshot;
      const stalePoll = Promise.withResolvers<Snapshot>();
      bridge.snapshot.mockReturnValueOnce(stalePoll.promise);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(bridge.snapshot).toHaveBeenCalledTimes(2);
      const newSnapshot = {
        ...original,
        projects:
          kind === 'remove'
            ? original.projects.filter((p) => p.id !== 'p-beta')
            : [...original.projects].reverse(),
        sessions: kind === 'remove' ? sessions.filter((s) => s.id !== 'beta') : sessions,
      };
      bridge.snapshot.mockResolvedValueOnce(newSnapshot);
      await act(async () => desktop.run(async () => {}));
      expect(desktop.snapshot).toEqual(newSnapshot);
      await act(async () => {
        if (kind === 'stale error') stalePoll.reject(new Error('old poll failed'));
        else stalePoll.resolve(original);
      });
      expect(desktop.snapshot).toEqual(newSnapshot);
      expect(desktop.connected).toBe(true);
      expect(desktop.error).toBe('');
      if (kind === 'remove') {
        expect(desktop.project).toBeNull();
        expect(desktop.selected).toBeNull();
        expect(desktop.openSessionIds).toEqual(['alpha']);
      }
    },
  );

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

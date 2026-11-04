// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetPanel } from '../src/FleetPanel';
import { PINNED_SESSIONS_KEY } from '../src/model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessions = ['a', 'b'].map((id, index) => ({
  id,
  projectId: 'p1',
  title: `Session ${id}`,
  kind: 'agent' as const,
  workdir: `/repo/${id}`,
  status: 'stopped' as const,
  createdAt: 1,
  updatedAt: 10 + index,
  exitCode: null,
  error: null,
}));
const snapshot = {
  projects: [{ id: 'p1', name: 'Project', root: '/repo', createdAt: 1 }],
  sessions,
  hostPid: 1,
  layout: null,
};
const vm = {
  snapshot,
  project: null,
  selected: null,
  filter: 'all',
  setFilter: () => {},
  search: '',
  setSearch: () => {},
  pending: false,
  run: async () => {},
  newSession: () => {},
  active: [],
  attention: [],
  sessions,
  jumpToSession: () => {},
};

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

async function mountWindow(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => root.render(createElement(FleetPanel, { vm: vm as never })));
  return container;
}

function card(container: HTMLDivElement, id: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('article.session-card')].find((item) =>
    item.textContent?.includes(`Session ${id}`),
  );
  if (!found) throw new Error(`card ${id} missing`);
  return found;
}

function pinButton(container: HTMLDivElement, id: string): HTMLButtonElement {
  return card(container, id).querySelector('.card-pin') as HTMLButtonElement;
}

async function clickPin(container: HTMLDivElement, id: string): Promise<void> {
  await act(async () => pinButton(container, id).click());
}

function stored(): unknown {
  const raw = localStorage.getItem(PINNED_SESSIONS_KEY);
  return raw === null ? [] : JSON.parse(raw);
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  localStorage.clear();
});

describe('pinned sessions across desktop windows', () => {
  it('pins and unpins in a single window', async () => {
    const window = await mountWindow();
    await clickPin(window, 'a');
    expect(stored()).toEqual(['a']);
    expect(pinButton(window, 'a').getAttribute('aria-pressed')).toBe('true');
    await clickPin(window, 'a');
    expect(stored()).toEqual([]);
  });

  it('keeps the first window pin when a second window pins', async () => {
    const first = await mountWindow();
    const second = await mountWindow();
    await clickPin(first, 'a');
    await clickPin(second, 'b');
    expect(stored()).toEqual(['a', 'b']);
    expect(card(first, 'a').classList.contains('pinned')).toBe(true);
    expect(card(second, 'b').classList.contains('pinned')).toBe(true);
  });

  it('refreshes the visible pin state from a storage event', async () => {
    const first = await mountWindow();
    const second = await mountWindow();
    await clickPin(first, 'a');
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: PINNED_SESSIONS_KEY }));
    });
    expect(pinButton(second, 'a').getAttribute('aria-pressed')).toBe('true');
    await clickPin(second, 'a');
    expect(stored()).toEqual([]);
  });
});

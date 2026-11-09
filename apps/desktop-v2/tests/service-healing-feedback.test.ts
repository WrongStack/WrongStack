// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundServices } from '../src/BackgroundServices';
import type { EngineCommand } from '../src/engine-operations';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});
const event = (phase: string, at = Date.now()) => ({
  type: 'connections.auto_heal_status',
  payload: {
    serviceId: 'session-catalog',
    phase,
    at,
    attempt: 1,
    message: 'Fixture service decision: ' + phase,
  },
});
async function mount() {
  const command = vi.fn<EngineCommand>(async (type) => {
    if (type !== 'connections.health')
      throw Error('No manual restart should be sent by a status event');
    return {
      overall: 'error',
      checkedAt: Date.now(),
      services: [
        { id: 'session-catalog', label: 'Session Catalog', status: 'error', control: 'restart' },
      ],
    };
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  roots.push(root);
  let state = emptyEngineState;
  const render = async (frame?: ReturnType<typeof event>) => {
    if (frame) state = reduceEngine(state, frame);
    await act(async () =>
      root.render(createElement(BackgroundServices, { command, autoHeals: state.serviceHealing })),
    );
  };
  await render();
  const row = () => host.querySelector('li')!;
  const buttons = () => [...row().querySelectorAll('button')];
  return { host, command, render, row, buttons };
}

describe('native service-healing feedback', () => {
  it.each(['restarted', 'failed', 'escalated', 'refused'])(
    'shows %s, refreshes health and restores manual controls',
    async (phase) => {
      const h = await mount();
      const at = Date.now();
      await h.render(event('restarting', at));
      expect(h.row().querySelector('[role=status]')?.textContent).toContain('restarting');
      expect(h.buttons().every((button) => button.disabled)).toBe(true);
      const before = h.command.mock.calls.length;
      await h.render(event(phase, at + 1));
      expect(h.row().querySelector('[role=status]')?.textContent).toContain(
        'Fixture service decision: ' + phase,
      );
      expect(h.buttons().every((button) => !button.disabled)).toBe(true);
      expect(h.command.mock.calls.length).toBeGreaterThan(before);
      expect(h.command.mock.calls.every(([type]) => type === 'connections.health')).toBe(true);
    },
  );
  it('keeps an older restart from replacing terminal feedback', async () => {
    const h = await mount(),
      at = Date.now();
    await h.render(event('failed', at));
    await h.render(event('restarting', at - 1));
    expect(h.row().querySelector('[role=status]')?.textContent).toContain(
      'Fixture service decision: failed',
    );
    expect(h.buttons().every((button) => !button.disabled)).toBe(true);
  });
  it('releases manual controls and explains a missing terminal event after the stale window', async () => {
    const h = await mount();
    await h.render(event('restarting', Date.now() - 120001));
    expect(h.buttons().every((button) => !button.disabled)).toBe(true);
    expect(h.row().querySelector('[role=status]')?.textContent).toContain(
      'No recent completion event',
    );
  });
});

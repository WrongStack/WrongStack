// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundServices } from '../src/BackgroundServices';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const health = {
  overall: 'healthy',
  services: [
    { id: 'webui', label: 'WebUI', status: 'healthy' },
    { id: 'catalog', label: 'Session catalog', status: 'healthy', control: 'shutdown' },
    { id: 'kanban', label: 'Kanban', status: 'degraded', control: 'shutdown' },
    { id: 'chronicle', label: 'Chronicle', status: 'offline', control: 'shutdown' },
    { id: 'sage', label: 'Memory', status: 'healthy', control: 'none' },
  ],
};

async function mount(fail = '') {
  const command = vi.fn(async (type: string, payload: Record<string, unknown>) => {
    if (type === 'connections.health') return health;
    if (payload['serviceId'] === fail) throw new Error('daemon did not answer');
    return { message: 'restarted' };
  });
  const host = document.createElement('div');
  await act(async () =>
    createRoot(host).render(createElement(BackgroundServices, { command: command as never })),
  );
  const restartAll = () =>
    [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Restart all'),
    );
  return { host, command, restartAll };
}

describe('restart all background services', () => {
  it('restarts every running service the engine controls, and only those', async () => {
    const { host, command, restartAll } = await mount();
    expect(restartAll()?.textContent).toBe('Restart all running (2)');
    await act(async () => restartAll()?.click());
    const restarted = command.mock.calls
      .filter(([type]) => type === 'connections.service_action')
      .map(([, payload]) => payload['serviceId']);
    expect(restarted).toEqual(['catalog', 'kanban']);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Restarted 2 of 2 services.');
  });

  it('keeps going past a failed restart and names it', async () => {
    const { host, restartAll } = await mount('catalog');
    await act(async () => restartAll()?.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Restarted 1 of 2 services.');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Session catalog: daemon did not answer',
    );
  });
});

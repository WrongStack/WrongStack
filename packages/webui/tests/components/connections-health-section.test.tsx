import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { handlers, send } = vi.hoisted(() => ({
  handlers: new Map<string, (message: unknown) => void>(),
  send: vi.fn(),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    client: {
      supportsCapability: () => true,
      send,
      on: (type: string, handler: (message: unknown) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    },
  }),
}));

vi.mock('@/stores', () => ({
  useConfigStore: (selector: (state: { wsConnected: boolean }) => unknown) =>
    selector({ wsConnected: true }),
}));

import { ConnectionsHealthSection } from '@/components/SettingsPanel/ConnectionsHealthSection';

afterEach(() => {
  cleanup();
  handlers.clear();
  send.mockReset();
  vi.useRealTimers();
});

describe('ConnectionsHealthSection', () => {
  it('requests and renders service ownership and health details', () => {
    render(<ConnectionsHealthSection />);
    expect(send).toHaveBeenCalledWith({ type: 'connections.health' });

    act(() => {
      handlers.get('connections.health_result')?.({
        type: 'connections.health_result',
        payload: {
          checkedAt: Date.now(),
          overall: 'healthy',
          backend: 'cli-embedded',
          projectRoot: '/project',
          services: [
            {
              id: 'webui',
              label: 'WebUI transport',
              status: 'healthy',
              required: true,
              mode: 'cli-embedded',
              detail: 'connected',
              ownerPid: 42,
            },
            {
              id: 'chronicle',
              label: 'Chronicle telemetry',
              status: 'healthy',
              required: true,
              mode: 'server',
              detail: 'one owner',
              ownerPid: 43,
              clients: 3,
              activeRequests: 1,
              queuedWork: 0,
              storage: '/state/project/chronicle',
              watcher: { active: true, watchedFiles: 12 },
            },
            {
              id: 'sage',
              label: 'SAGE memory',
              status: 'offline',
              required: false,
              mode: 'on-demand project-server',
              detail: 'starts on demand',
            },
            {
              id: 'governance',
              label: 'Governance control plane',
              status: 'degraded',
              required: false,
              mode: 'project-daemon-advisory',
              detail:
                'Attachment broker renewal health is degraded. Execution continues; no automatic task or model stop.',
              ownerPid: 44,
              control: 'none',
              advisory: {
                code: 'attachment_broker_degraded',
                operatorAction: 'investigate',
                executionDisposition: 'continue',
              },
            },
          ],
        },
      });
    });

    expect(screen.getByText('Connection health')).toBeTruthy();
    expect(screen.getByText('Chronicle telemetry')).toBeTruthy();
    expect(screen.getByText('SAGE memory')).toBeTruthy();
    expect(screen.getByText('Governance control plane')).toBeTruthy();
    expect(screen.getByText('attachment_broker_degraded')).toBeTruthy();
    expect(screen.getByText('investigate')).toBeTruthy();
    expect(screen.getByText('continue')).toBeTruthy();
    expect(screen.queryByTitle(/Reset Governance control plane/u)).toBeNull();
    expect(screen.getByText('server')).toBeTruthy();
    expect(screen.getByText('on-demand project-server')).toBeTruthy();
    expect(screen.getByText('/state/project/chronicle')).toBeTruthy();
    expect(screen.getByText(/3 healthy|2 healthy/)).toBeTruthy();
  });
});

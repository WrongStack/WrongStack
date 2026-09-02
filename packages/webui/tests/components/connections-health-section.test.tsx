import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { handlers, send, wsClient } = vi.hoisted(() => {
  const handlers = new Map<string, (message: unknown) => void>();
  // One client instance for the whole module: the component's subscription
  // effect keys on [client], so a per-render client object would tear the
  // effect down (sweeping the feedback timers) on every state change.
  const send = vi.fn();
  const wsClient = {
    supportsCapability: () => true,
    send,
    on: (type: string, handler: (message: unknown) => void) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
  };
  return { handlers, send, wsClient };
});

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ client: wsClient }),
}));

vi.mock('@/stores', () => ({
  useConfigStore: (selector: (state: { wsConnected: boolean }) => unknown) =>
    selector({ wsConnected: true }),
}));

import { ConnectionsHealthSection } from '@/components/SettingsPanel/ConnectionsHealthSection';
import type {
  AutoHealStatusEvent,
  AutoHealStatusPhase,
  ConnectionHealthService,
  ConnectionsHealthReport,
} from '@/types';

afterEach(() => {
  cleanup();
  handlers.clear();
  send.mockReset();
  vi.useRealTimers();
});

function emit(type: string, payload: unknown): void {
  act(() => {
    handlers.get(type)?.({ type, payload });
  });
}

function healthResult(
  services: Array<Pick<ConnectionHealthService, 'id' | 'status'>>,
): ConnectionsHealthReport {
  return {
    checkedAt: Date.now(),
    overall: 'healthy',
    backend: 'cli-embedded',
    projectRoot: '/project',
    services: services.map((s) => ({
      id: s.id,
      label: s.id,
      status: s.status,
      required: true,
      mode: 'project-server',
      detail: `${s.id} ${s.status}`,
    })),
  };
}

function autoHealEvent(
  phase: AutoHealStatusPhase,
  serviceId: ConnectionHealthService['id'] | null,
  message = `${phase} ${serviceId ?? ''}`.trim(),
): AutoHealStatusEvent {
  return { serviceId, phase, message, at: Date.now(), attempt: 1 };
}

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

  it('shows the auto-restarting badge while healing and clears it with feedback on restart', async () => {
    vi.useFakeTimers();
    render(<ConnectionsHealthSection />);
    emit('connections.health_result', healthResult([{ id: 'kanban', status: 'error' }]));

    emit('connections.auto_heal_status', autoHealEvent('restarting', 'kanban'));
    expect(screen.getByTestId('auto-restarting-badge')).toBeTruthy();

    emit('connections.auto_heal_status', autoHealEvent('restarted', 'kanban', 'restarted ok'));
    expect(screen.queryByTestId('auto-restarting-badge')).toBeNull();
    expect(screen.getByText('restarted ok')).toBeTruthy();

    // Feedback auto-clears after 5s; the timer must actually fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByText('restarted ok')).toBeNull();
  });

  it('ignores auto-heal events without a serviceId', () => {
    render(<ConnectionsHealthSection />);
    emit('connections.health_result', healthResult([{ id: 'kanban', status: 'error' }]));
    emit('connections.auto_heal_status', autoHealEvent('restarting', null));
    expect(screen.queryByTestId('auto-restarting-badge')).toBeNull();
  });

  it('a restarting event supersedes prior terminal feedback for the same service', async () => {
    vi.useFakeTimers();
    render(<ConnectionsHealthSection />);
    emit('connections.health_result', healthResult([{ id: 'kanban', status: 'error' }]));

    emit('connections.auto_heal_status', autoHealEvent('failed', 'kanban', 'attempt 1 failed'));
    expect(screen.getByText('attempt 1 failed')).toBeTruthy();
    // t=4s: the failed-event clear is due at t=5s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    emit('connections.auto_heal_status', autoHealEvent('restarting', 'kanban'));
    expect(screen.getByTestId('auto-restarting-badge')).toBeTruthy();
    // The stale terminal row is dropped immediately, not after its timer.
    expect(screen.queryByText('attempt 1 failed')).toBeNull();

    emit('connections.auto_heal_status', autoHealEvent('restarted', 'kanban', 'healed'));
    // Cancel-regression: t=5s is where the CANCELED failed-event timer would
    // have fired. The newer feedback must survive that slot…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText('healed')).toBeTruthy();
    // …and the restarted event's own 5s clear (due t=9s) still runs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.queryByText('healed')).toBeNull();
  });

  it('renders a policy refusal with neutral copy, not a failure tone', () => {
    render(<ConnectionsHealthSection />);
    emit('connections.health_result', healthResult([{ id: 'kanban', status: 'error' }]));
    emit(
      'connections.auto_heal_status',
      autoHealEvent('refused', 'kanban', 'refused by policy: nope'),
    );
    const feedback = screen.getByText('refused by policy: nope');
    expect(feedback.className).toContain('text-muted-foreground');
    expect(feedback.className).not.toContain('text-destructive');
  });

  it('clears a stuck badge when a fresh health report shows the service out of error', () => {
    render(<ConnectionsHealthSection />);
    emit('connections.health_result', healthResult([{ id: 'kanban', status: 'error' }]));
    emit('connections.auto_heal_status', autoHealEvent('restarting', 'kanban'));
    expect(screen.getByTestId('auto-restarting-badge')).toBeTruthy();

    // Terminal event missed — the next health_result is the ground truth.
    emit('connections.health_result', healthResult([{ id: 'kanban', status: 'healthy' }]));
    expect(screen.queryByTestId('auto-restarting-badge')).toBeNull();
  });

  it('sweeps pending feedback timers on unmount without errors', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<ConnectionsHealthSection />);
    emit('connections.health_result', healthResult([{ id: 'kanban', status: 'error' }]));
    emit('connections.auto_heal_status', autoHealEvent('restarted', 'kanban', 'done'));
    unmount();
    // Advancing past the timer must be a no-op — no setState-after-unmount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.queryByText('done')).toBeNull();
  });
});

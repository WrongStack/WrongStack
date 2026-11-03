import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SageHealthPanel } from '../../src/components/MemoryManager/SageHealthPanel.js';
import {
  sortDoctorChecks,
  suggestedFixes,
} from '../../src/components/MemoryManager/sage-health-model.js';
import type { SageDoctorReport } from '../../src/types/sage-doctor.js';

const translation = vi.hoisted(() => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
}));
vi.mock('@/i18n', () => ({ useAppTranslation: () => translation }));
vi.mock('@wrongstack/project-surfaces/lib/i18n', () => ({ useAppTranslation: () => translation }));
afterEach(cleanup);

const MEMORY_ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

function makeReport(overrides: Partial<SageDoctorReport> = {}): SageDoctorReport {
  return {
    generatedAt: new Date().toISOString(),
    metrics: {
      total: 10,
      active: 8,
      byStatus: { active: 8, deleted: 2 },
      edges: 40,
      pendingCandidates: 3,
      injections: 200,
      uses: 50,
      precision: 0.25,
      injectedNeverUsed: 4,
      unanchoredActive: 2,
      neverVerifiedActive: 1,
      dbBytes: 2 * 1024 * 1024,
      walBytes: 4096,
    },
    checks: [
      { id: 'fts', title: 'FTS index', severity: 'ok', summary: 'in sync' },
      {
        id: 'graph-hubs',
        title: 'Graph hubs',
        severity: 'warn',
        summary: '2 hub nodes',
        fix: 'graph-hubs',
        samples: ['tag:webui (120)'],
      },
      {
        id: 'expired-active',
        title: 'Expired memories still active',
        severity: 'error',
        summary: '1 expired',
        fix: 'hygiene',
        samples: [MEMORY_ID],
      },
      { id: 'neverused', title: 'Never used', severity: 'info', summary: 'note', fix: 'hygiene' },
    ],
    maintenance: {
      owner: 'daemon',
      scheduled: true,
      intervalMs: 3_600_000,
      running: false,
      lastRunAt: new Date().toISOString(),
      lastError: 'disk full',
    },
    ...overrides,
  };
}

function mount(respond: (opts: { fix?: string[]; requestId?: string }) => unknown) {
  const handlers = new Set<(message: unknown) => void>();
  const client = {
    on(_type: string, callback: (message: unknown) => void) {
      handlers.add(callback);
      return () => handlers.delete(callback);
    },
  } as unknown as ComponentProps<typeof SageHealthPanel>['client'];
  const sageDoctor = vi.fn((opts?: { fix?: string[]; requestId?: string }, _options?: unknown) => {
    const payload = respond(opts ?? {});
    if (payload === undefined) return;
    queueMicrotask(() => {
      for (const handler of [...handlers]) {
        handler({
          type: 'memory.sage.doctor',
          payload: { ...(payload as object), requestId: opts?.requestId },
        });
      }
    });
  });
  const onOpenMemory = vi.fn();
  const onReport = vi.fn();
  render(
    <SageHealthPanel
      active
      client={client}
      sageDoctor={sageDoctor}
      onOpenMemory={onOpenMemory}
      onReport={onReport}
    />,
  );
  return { sageDoctor, onOpenMemory, onReport, handlers };
}

describe('SageHealthPanel', () => {
  it('loads once on activation and renders metrics, maintenance and sorted checks', async () => {
    const { sageDoctor, onReport } = mount(() => ({ report: makeReport() }));
    const checks = await screen.findAllByTestId('doctor-check');
    expect(sageDoctor).toHaveBeenCalledTimes(1);
    expect(sageDoctor.mock.calls[0]?.[0]).not.toHaveProperty('fix');
    expect(checks.map((el) => el.getAttribute('data-severity'))).toEqual([
      'error',
      'warn',
      'info',
      'ok',
    ]);
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('8 / 10')).toBeTruthy();
    expect(screen.getByText('2.0 MB / 4.0 KB')).toBeTruthy();
    expect(screen.getByText('disk full')).toBeTruthy();
    expect(onReport).toHaveBeenCalledWith(
      expect.objectContaining({ generatedAt: expect.any(String) }),
    );
  });

  it('offers Fix only for warn/error checks with a fix, and sends that fix id', async () => {
    const { sageDoctor } = mount((opts) =>
      opts.fix
        ? {
            report: makeReport({
              fixesApplied: [{ fix: 'graph-hubs', changed: 7, detail: 'removed 7 hub edges' }],
            }),
          }
        : { report: makeReport() },
    );
    await screen.findAllByTestId('doctor-check');
    const fixButtons = screen.getAllByRole('button', {
      name: /activity:memoryManager\.healthFix /,
    });
    // error(hygiene) + warn(graph-hubs); the info check's fix is not offered.
    expect(fixButtons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'activity:memoryManager.healthFix hygiene',
      'activity:memoryManager.healthFix graph-hubs',
    ]);
    fireEvent.click(fixButtons[1]!);
    await waitFor(() => expect(sageDoctor).toHaveBeenCalledTimes(2));
    expect(sageDoctor.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ fix: ['graph-hubs'], requestId: expect.any(String) }),
    );
    expect(sageDoctor.mock.calls[1]?.[1]).toEqual({ echoToChat: false });
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('activity:memoryManager.healthFixesApplied');
    expect(status.textContent).toContain('removed 7 hub edges');
  });

  it('"Fix all suggested" sends every warn/error fix once', async () => {
    const { sageDoctor } = mount(() => ({ report: makeReport() }));
    await screen.findAllByTestId('doctor-check');
    fireEvent.click(screen.getByRole('button', { name: /healthFixAll/ }));
    await waitFor(() => expect(sageDoctor).toHaveBeenCalledTimes(2));
    expect(sageDoctor.mock.calls[1]?.[0]?.fix).toEqual(['hygiene', 'graph-hubs']);
  });

  it('shows server errors and keeps the last report', async () => {
    let call = 0;
    mount(() => (++call === 1 ? { report: makeReport() } : { error: 'Unknown doctor fix: x' }));
    await screen.findAllByTestId('doctor-check');
    fireEvent.click(screen.getByRole('button', { name: 'common:action.refresh' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unknown doctor fix: x');
    expect(screen.getAllByTestId('doctor-check')).toHaveLength(4);
  });

  it('opens memory-id samples and leaves other samples as plain text', async () => {
    const { onOpenMemory } = mount(() => ({ report: makeReport() }));
    await screen.findAllByTestId('doctor-check');
    fireEvent.click(screen.getByRole('button', { name: `${MEMORY_ID.slice(0, 16)}…` }));
    expect(onOpenMemory).toHaveBeenCalledWith(MEMORY_ID);
    expect(screen.getByText('tag:webui (120)').tagName).toBe('SPAN');
  });

  it('ignores replies to other doctor requests', async () => {
    const { handlers } = mount(() => undefined);
    act(() => {
      for (const handler of [...handlers]) {
        handler({ type: 'memory.sage.doctor', payload: { report: makeReport(), requestId: 'x' } });
      }
    });
    expect(screen.queryAllByTestId('doctor-check')).toHaveLength(0);
  });
});

describe('doctor helpers', () => {
  it('sorts error > warn > info > ok and derives suggested fixes', () => {
    const report = makeReport();
    expect(sortDoctorChecks(report.checks).map((c) => c.severity)).toEqual([
      'error',
      'warn',
      'info',
      'ok',
    ]);
    expect(suggestedFixes(report)).toEqual(['hygiene', 'graph-hubs']);
  });
});

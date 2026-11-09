// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../src/engine-state';
import { SessionToolStats } from '../src/SessionToolStats';
import { surfaceI18n } from '../src/surface-i18n';
import { catalogToolStats, conversationToolStats, successRate } from '../src/tool-stats-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const started = (name: string, agentName?: string): EngineEvent => ({
  type: 'tool.started',
  payload: { name, ...(agentName ? { agentName } : {}) },
});
const executed = (name: string, ok: boolean, durationMs?: number, agentName?: string) =>
  ({
    type: 'tool.executed',
    payload: {
      name,
      ok,
      ...(durationMs ? { durationMs } : {}),
      ...(agentName ? { agentName } : {}),
    },
  }) as EngineEvent;

describe('tool statistics of one conversation', () => {
  it('counts calls, outcomes and time per tool and per agent', () => {
    const stats = conversationToolStats([
      started('read'),
      executed('read', true, 200),
      started('read'),
      executed('read', false, 100),
      started('bash'),
      executed('bash', true, 1000),
      started('edit', 'reviewer'),
      executed('edit', true, 50, 'reviewer'),
      started('grep'),
      { type: 'tool.progress', payload: { name: 'grep' } },
      { type: 'run.result', payload: {} },
    ]);
    expect(stats.tools.map((tool) => [tool.name, tool.started, tool.ok, tool.failed])).toEqual([
      ['read', 2, 1, 1],
      ['bash', 1, 1, 0],
      ['edit', 1, 1, 0],
      ['grep', 1, 0, 0],
    ]);
    expect(stats.tools[0]?.totalMs).toBe(300);
    expect(stats.agents).toEqual([{ name: 'reviewer', started: 1, ok: 1, failed: 0, totalMs: 50 }]);
    expect(stats.totals).toEqual({ started: 5, ok: 3, failed: 1, totalMs: 1350, inFlight: 1 });
    // An outcome without its start (a journal cut mid-turn) still counts as a call.
    expect(conversationToolStats([executed('write', true)]).totals.started).toBe(1);
  });

  it('rounds the success rate and has none before anything finishes', () => {
    expect(successRate(2, 1)).toBe(67);
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(2, -1)).toBe(100);
    expect(successRate(Number.NaN, 0)).toBeNull();
    expect(
      conversationToolStats([{ type: 'tool.started', payload: { name: '   ' } }]).tools[0]?.name,
    ).toBe('tool');
  });
});

describe('tool statistics across the project', () => {
  it('sums the catalog’s counts and per-tool breakdowns, busiest first', () => {
    const stats = catalogToolStats({
      sessions: [
        {
          id: 'a',
          title: 'Fix login',
          toolCallCount: 4,
          toolErrorCount: 1,
          toolBreakdown: { read: 3, bash: 1 },
        },
        {
          id: 'b',
          name: 'Nicknamed',
          title: 'x',
          toolCallCount: 10,
          toolErrorCount: 0,
          toolBreakdown: { read: 6, edit: 4 },
          isCurrent: true,
        },
        { id: 'c', title: 'Idle', toolCallCount: 0 },
        { title: 'no id', toolCallCount: 9 },
      ],
    });
    expect(stats.sessions.map((row) => [row.title, row.calls, row.failed, row.current])).toEqual([
      ['Nicknamed', 10, 0, true],
      ['Fix login', 4, 1, false],
    ]);
    expect(stats.tools).toEqual([
      { name: 'read', calls: 9 },
      { name: 'edit', calls: 4 },
      { name: 'bash', calls: 1 },
    ]);
    expect([stats.calls, stats.failed]).toEqual([14, 1]);
  });
});

describe('the tool statistics view', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('shows this conversation per tool and reads the project’s catalog', async () => {
    await surfaceI18n.changeLanguage('en');
    const command = vi.fn(async () => ({
      sessions: [
        {
          id: 'a',
          title: 'Fix login',
          toolCallCount: 4,
          toolErrorCount: 1,
          toolBreakdown: { read: 4 },
        },
      ],
    }));
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(SessionToolStats, {
          activity: {
            turnActivity: { m1: [started('read'), executed('read', true, 300)] },
            runTimeline: [started('bash'), executed('bash', false, 100)],
          },
          connected: true,
          command: command as never,
        }),
      ),
    );
    expect(command).toHaveBeenCalledWith('sessions.list', { limit: 50 }, ['sessions.list']);
    const table = host.querySelector('table[aria-label="Calls per tool"]');
    expect(
      [...(table?.querySelectorAll('tbody th') ?? [])].map((cell) => cell.textContent),
    ).toEqual(['read', 'bash']);
    expect(host.textContent).toContain('Success rate');
    expect(host.textContent).toContain('50%');
    expect(host.textContent).toContain('Fix login');
    expect(host.textContent).toContain('4 calls · 1 failed · 75%');
    await act(async () => {
      await surfaceI18n.changeLanguage('tr');
    });
    expect(host.textContent).toContain('Araç çağrıları');
    expect(host.textContent).toContain('4 çağrı · 1 başarısız · 75%');
    act(() => root.unmount());
  });
});

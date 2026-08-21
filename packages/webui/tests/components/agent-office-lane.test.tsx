/**
 * Integration: the waiting-desk badge must route its click to what backs the
 * claim. A mail-reply desk opens the pending MAIL detail — never an empty
 * task panel — and a desk whose anchor is unknown does nothing on click.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLane } from '../../src/components/AgentOfficeView';
import type { OfficeAgentModel } from '../../src/components/AgentOfficeView/model';
import type { OfficeMailActivity, OfficeToolCall } from '../../src/lib/agent-office';

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    // Fall through to the raw key — assertions only need stability, not text.
    t: (key: string) => key,
  }),
}));

const NOW = 1_000_000;

function agent(overrides: Record<string, unknown> = {}) {
  return {
    serverId: 'worker-1',
    name: 'Worker One',
    role: 'builder',
    status: 'active',
    toolCalls: 3,
    tokensIn: 1500,
    tokensOut: 300,
    costUsd: 0.0123,
    ...overrides,
  } as never;
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    type: 'webui',
    todos: [{ text: 'x', status: 'in_progress' }],
    ...overrides,
  } as never;
}

function call(overrides: Partial<OfficeToolCall> = {}): OfficeToolCall {
  return {
    id: 'c1',
    toolName: 'read_file',
    kind: 'read',
    status: 'succeeded',
    startedAt: NOW - 400_000,
    completedAt: NOW - 400_000,
    summary: 'read model.ts',
    ...overrides,
  } as OfficeToolCall;
}

function mail(overrides: Partial<OfficeMailActivity> = {}): OfficeMailActivity {
  return {
    id: 'm-out',
    direction: 'outgoing',
    timestampMs: NOW - 300_000,
    subject: 'review my patch?',
    priority: 'normal',
    unread: false,
    ...overrides,
  } as OfficeMailActivity;
}

function model(overrides: Partial<OfficeAgentModel> = {}): OfficeAgentModel {
  return {
    key: 'k',
    client: client(),
    agent: agent(),
    calls: [],
    history: [call()],
    mail: [mail()],
    ...overrides,
  } as OfficeAgentModel;
}

describe('AgentLane wait badge click routing', () => {
  afterEach(cleanup);

  it('mail-reply desk: clicking the badge opens the pending MAIL detail', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <AgentLane model={model()} now={NOW} onSelect={onSelect} />,
    );

    const badge = container.querySelector<HTMLButtonElement>('.agent-office__wait-badge');
    expect(badge).not.toBeNull();
    expect(badge!.className).toContain('is-mail-reply');

    fireEvent.click(badge!);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mail', agentName: 'Worker One' }),
    );
    const arg = onSelect.mock.calls[0]![0] as { kind: string; mail: { id: string } };
    expect(arg.mail.id).toBe('m-out');
  });

  it('no-work desk with a current task: clicking opens the TASK detail', () => {
    const onSelect = vi.fn();
    render(
      <AgentLane
        model={model({ mail: [], agent: agent({ currentTask: 'refactor X' }) })}
        now={NOW}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /waitingNoWork/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task',
        task: 'refactor X',
        agentName: 'Worker One',
      }),
    );
  });

  it('no-work desk without a current task: clicking does nothing (no empty task panel)', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <AgentLane model={model({ mail: [], agent: agent({ currentTask: '' }) })} now={NOW} onSelect={onSelect} />,
    );

    const badge = container.querySelector('.agent-office__wait-badge');
    expect(badge).not.toBeNull();
    // Not actionable → rendered as a status element, not a button.
    expect(badge!.tagName).toBe('SPAN');
    fireEvent.click(badge!);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('fresh desk below the threshold: no badge at all', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <AgentLane
        model={model({ history: [call({ completedAt: NOW - 5_000 })], mail: [] })}
        now={NOW}
        onSelect={onSelect}
      />,
    );
    expect(container.querySelector('.agent-office__wait-badge')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('metrics strip renders tokens, cost, context and the action one-liner', () => {
    const { container } = render(
      <AgentLane
        // display = the freshest call shown on the conveyor; its summary feeds the one-liner.
        model={model({ display: call() })}
        now={NOW}
        onSelect={vi.fn()}
      />,
    );

    const strip = container.querySelector('.agent-office__desk-metrics');
    expect(strip).not.toBeNull();
    // fmtTok(1500 + 300) → "1.8K"; fmtCost(0.0123) → "$0.012"; ctx missing → "—"
    expect(strip!.textContent).toContain('1.8K');
    expect(strip!.textContent).toContain('TOK');
    expect(strip!.textContent).toContain('$0.012');
    expect(strip!.textContent).toContain('CTX');
    expect(strip!.textContent).toContain('read model.ts');
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ArchitectureDecision } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchitectureDecisionHistory } from '../../src/components/ArchitectureDecisionHistory';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/portable-command-rpc', () => ({ invokePortableCommand: rpc }));
vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string, opts?: { revision?: number }) =>
      opts?.revision ? `${key}:${opts.revision}` : key,
  }),
}));
const current: ArchitectureDecision = {
  id: 'ADR-current',
  projectId: 'p',
  title: 'Boundary',
  revision: 3,
  contentHash: 'a'.repeat(64),
  status: 'accepted',
  context: 'Current context',
  decision: 'Current decision',
  alternatives: [],
  consequences: [],
  constraints: [],
  scope: [],
  revisitWhen: '',
  createdAt: '',
  updatedAt: '',
  proposedBy: 'worker',
  resolvedBy: 'user',
  resolutionReason: 'Reviewed.',
};
const summary = (revision: number) => ({ ...current, revision });
const page = (records = [summary(3), summary(2)], nextBeforeRevision: number | null = null) => ({
  message: JSON.stringify({ projectId: 'p', decisionId: current.id, records, nextBeforeRevision }),
});
beforeEach(() => {
  rpc.mockReset().mockImplementation(async (_name: string, args: string) =>
    args.startsWith('history-json')
      ? page()
      : {
          message: JSON.stringify({
            ...current,
            revision: Number(args.split(' ')[2]),
            decision: `Historical decision ${args.split(' ')[2]}`,
          }),
        },
  );
});
afterEach(cleanup);

describe('ADR historical revisions', () => {
  it('loads on demand and displays a read-only snapshot without review or edit actions', async () => {
    render(<ArchitectureDecisionHistory record={current} sessionId="s" />);
    expect(rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.history.title' }));
    fireEvent.click(await screen.findByRole('button', { name: /history.revision:2/ }));
    const snapshot = await screen.findByRole('region', { name: 'activity:adr.history.snapshot' });
    expect(within(snapshot).getByText('Historical decision 2')).toBeTruthy();
    expect(within(snapshot).getByText('activity:adr.history.readonly')).toBeTruthy();
    expect(snapshot.textContent).toContain('Reviewed.');
    expect(within(snapshot).queryAllByRole('button')).toHaveLength(0);
    expect(within(snapshot).queryAllByRole('textbox')).toHaveLength(0);
    expect(rpc.mock.calls.every(([, args]) => /^(history-json|revision-json) /.test(args))).toBe(
      true,
    );
  });

  it('loads older revisions using the returned immutable cursor', async () => {
    rpc.mockImplementation(async (_name: string, args: string) =>
      args.endsWith(' 3') ? page([summary(2)], null) : page([summary(3)], 3),
    );
    render(<ArchitectureDecisionHistory record={current} sessionId="s" />);
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.history.title' }));
    fireEvent.click(await screen.findByRole('button', { name: 'activity:adr.history.more' }));
    await screen.findByRole('button', { name: /history.revision:2/ });
    expect(screen.getByRole('button', { name: /history.revision:3/ })).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith(
      'adr',
      `history-json ${current.id} 3`,
      expect.objectContaining({ sessionId: 's' }),
    );
    expect(screen.queryByRole('button', { name: 'activity:adr.history.more' })).toBeNull();
  });

  it('ignores a stale detail reply after a newer revision selection', async () => {
    let old!: (value: unknown) => void;
    rpc.mockImplementation(async (_name: string, args: string) =>
      args === `revision-json ${current.id} 3`
        ? new Promise((resolve) => {
            old = resolve;
          })
        : args.startsWith('history-json')
          ? page()
          : { message: JSON.stringify({ ...current, revision: 2, decision: 'Chosen revision' }) },
    );
    render(<ArchitectureDecisionHistory record={current} sessionId="s" />);
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.history.title' }));
    fireEvent.click(await screen.findByRole('button', { name: /history.revision:3/ }));
    fireEvent.click(screen.getByRole('button', { name: /history.revision:2/ }));
    await screen.findByText('Chosen revision');
    await act(async () => old({ message: JSON.stringify(current) }));
    expect(screen.getByText('Chosen revision')).toBeTruthy();
    expect(screen.queryByText('Current decision')).toBeNull();
  });

  it('cancels and ignores old-project replies after switching the review target', async () => {
    let old!: (value: unknown) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    );
    const view = render(<ArchitectureDecisionHistory record={current} sessionId="s" />);
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.history.title' }));
    const signal = rpc.mock.calls[0][2].signal as AbortSignal;
    view.rerender(
      <ArchitectureDecisionHistory
        record={{ ...current, id: 'ADR-other', projectId: 'other' }}
        sessionId="s-other"
      />,
    );
    expect(signal.aborted).toBe(true);
    await act(async () => old(page()));
    expect(screen.queryByRole('button', { name: /history.revision:3/ })).toBeNull();
  });

  it('surfaces history errors, rejects a foreign response and permits reloading', async () => {
    rpc.mockResolvedValueOnce({ error: 'Store unavailable' });
    render(<ArchitectureDecisionHistory record={current} sessionId="s" />);
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.history.title' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Store unavailable');
    rpc.mockResolvedValueOnce({
      message: JSON.stringify({ projectId: 'foreign', decisionId: current.id, records: [] }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.history.refresh' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('activity:adr.history.mismatch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.history.refresh' }));
    await screen.findByRole('button', { name: /history.revision:3/ });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

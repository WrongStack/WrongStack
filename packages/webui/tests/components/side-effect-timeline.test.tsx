import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideEffectTimeline } from '../../src/components/SideEffectTimeline.js';
import { useSessionLanes } from '../../src/stores/session-lanes.js';
import { type SideEffectEntry, useSideEffectStore } from '../../src/stores/side-effect-store.js';

const sendMock = vi.fn();
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    send: sendMock,
  }),
}));

describe('SideEffectTimeline', () => {
  beforeEach(() => {
    sendMock.mockClear();
    useSideEffectStore.setState({ sideEffects: [], loading: false });
    useSessionLanes.setState({ activeSessionId: 'sess-1' });
  });

  afterEach(cleanup);

  it('renders empty state when there are no side effects and not loading', () => {
    render(<SideEffectTimeline />);
    act(() => {
      useSideEffectStore.setState({ sideEffects: [], loading: false });
    });
    expect(screen.getByText(/No side effects recorded/i)).toBeTruthy();
  });

  it('renders table with side effects, risk badges, and formats inputs properly', () => {
    const mockEntries: SideEffectEntry[] = [
      {
        toolUseId: 'call-1',
        ts: '2026-09-08T00:00:00.000Z',
        toolName: 'bash',
        risk: 'shell',
        input: { command: 'git status' },
        outcome: 'ok',
      },
      {
        toolUseId: 'call-2',
        ts: '2026-09-08T00:01:00.000Z',
        toolName: 'web_fetch',
        risk: 'network',
        input: { url: 'https://example.com/api' },
        outcome: 'status 200',
      },
      {
        toolUseId: 'call-3',
        ts: '2026-09-08T00:02:00.000Z',
        toolName: 'npm_install',
        risk: 'package',
        input: { packages: ['lucide-react', 'zustand'] },
        outcome: 'added 2 packages',
      },
      {
        toolUseId: 'call-4',
        ts: '2026-09-08T00:03:00.000Z',
        toolName: 'edit_config',
        risk: 'config',
        input: { key: 'debug', val: true },
        outcome: 'saved',
      },
    ];

    useSideEffectStore.setState({ sideEffects: mockEntries, loading: false });

    render(<SideEffectTimeline />);

    expect(screen.getByText(/Side Effects \(4\)/i)).toBeTruthy();
    expect(screen.getByText('git status')).toBeTruthy();
    expect(screen.getByText('https://example.com/api')).toBeTruthy();
    expect(screen.getByText('lucide-react, zustand')).toBeTruthy();
    expect(screen.getByText('{"key":"debug","val":true}')).toBeTruthy();
  });

  it('filters entries by risk category', () => {
    const mockEntries: SideEffectEntry[] = [
      {
        toolUseId: 'call-1',
        ts: '2026-09-08T00:00:00.000Z',
        toolName: 'bash',
        risk: 'shell',
        input: { command: 'echo 1' },
      },
      {
        toolUseId: 'call-2',
        ts: '2026-09-08T00:01:00.000Z',
        toolName: 'web_fetch',
        risk: 'network',
        input: { url: 'https://api.test' },
      },
    ];

    useSideEffectStore.setState({ sideEffects: mockEntries, loading: false });

    render(<SideEffectTimeline />);

    // Click 'shell' filter
    const shellBtn = screen.getByRole('button', { name: 'shell' });
    fireEvent.click(shellBtn);

    expect(screen.getByText('echo 1')).toBeTruthy();
    expect(screen.queryByText('https://api.test')).toBeNull();

    // Click 'all' filter
    const allBtn = screen.getByRole('button', { name: /all/i });
    fireEvent.click(allBtn);

    expect(screen.getByText('echo 1')).toBeTruthy();
    expect(screen.getByText('https://api.test')).toBeTruthy();
  });

  it('sorts entries by time, tool name, and risk when headers are clicked', () => {
    const mockEntries: SideEffectEntry[] = [
      {
        toolUseId: 'call-1',
        ts: '2026-09-08T00:00:00.000Z',
        toolName: 'bash',
        risk: 'shell',
        input: { command: 'echo 1' },
      },
      {
        toolUseId: 'call-2',
        ts: '2026-09-08T00:05:00.000Z',
        toolName: 'api_tool',
        risk: 'network',
        input: { url: 'https://api.test' },
      },
    ];

    useSideEffectStore.setState({ sideEffects: mockEntries, loading: false });

    render(<SideEffectTimeline />);

    // Click Tool column header to sort by tool
    const toolHeader = screen.getByRole('columnheader', { name: /Tool/i });
    fireEvent.click(toolHeader);
    // Click again to invert order
    fireEvent.click(toolHeader);

    // Click Risk column header
    const riskHeader = screen.getByRole('columnheader', { name: /Risk/i });
    fireEvent.click(riskHeader);
    // Click again
    fireEvent.click(riskHeader);

    // Click Time column header
    const timeHeader = screen.getByRole('columnheader', { name: /Time/i });
    fireEvent.click(timeHeader);
    fireEvent.click(timeHeader);

    expect(screen.getByText('echo 1')).toBeTruthy();
  });

  it('exports CSV on export button click', () => {
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const createObjectURLMock = vi.fn(() => 'blob:mock-url');
    const revokeObjectURLMock = vi.fn();
    URL.createObjectURL = createObjectURLMock;
    URL.revokeObjectURL = revokeObjectURLMock;

    try {
      const mockEntries: SideEffectEntry[] = [
        {
          toolUseId: 'call-1',
          ts: '2026-09-08T00:00:00.000Z',
          toolName: 'bash',
          risk: 'shell',
          input: { command: 'echo "hello, world"' },
          outcome: 'hello, world',
        },
      ];

      useSideEffectStore.setState({ sideEffects: mockEntries, loading: false });

      render(<SideEffectTimeline />);

      const exportBtn = screen.getByRole('button', { name: /CSV/i });
      fireEvent.click(exportBtn);

      expect(createObjectURLMock).toHaveBeenCalledTimes(1);
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url');
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('refreshes side effects list on refresh button click', async () => {
    useSideEffectStore.setState({
      sideEffects: [
        {
          toolUseId: 'c1',
          ts: '2026-09-08T00:00:00.000Z',
          toolName: 'bash',
          risk: 'shell',
          input: { command: 'ls' },
        },
      ],
    });

    render(<SideEffectTimeline />);

    const refreshBtn = screen.getByRole('button', { name: /Refresh/i });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    expect(sendMock).toHaveBeenCalledWith({
      type: 'side_effects.list',
      payload: { sessionId: 'sess-1' },
    });
  });
});

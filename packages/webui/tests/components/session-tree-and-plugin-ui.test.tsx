import { fireEvent, render, screen } from '@testing-library/react';
import type { SessionTreeSnapshot } from '@wrongstack/contracts/types/session';
import {
  PluginStatusChipsBar,
  PluginViewNodeRenderer,
} from '@wrongstack/project-surfaces/plugin-ui';
import {
  flattenSessionBranchRows,
  SessionBranchPill,
} from '@wrongstack/project-surfaces/session-tree';
import { describe, expect, it, vi } from 'vitest';
import { matchSlash } from '../../src/components/ChatInput/slash-commands';
import { runChatSlashCommand } from '../../src/components/ChatInput/slash-routing';
import { ChatRowView } from '../../src/components/ChatView/ChatRowView';
import { SessionRowStats } from '../../src/components/SidePanel/SessionRowParts';

describe('WebUI & project-surfaces Session Tree and Declarative Plugin UI components', () => {
  const sampleTree: SessionTreeSnapshot = {
    activeBranchId: 'br_exp',
    headSeq: 8,
    branches: {
      main: {
        id: 'main',
        name: 'main',
        parentBranchId: null,
        forkSeq: 0,
        createdAt: '2026-11-11T10:00:00.000Z',
        lastActivityAt: '2026-11-11T10:01:00.000Z',
        status: 'active',
        turnCount: 2,
      },
      br_exp: {
        id: 'br_exp',
        name: 'try-sqlite',
        parentBranchId: 'main',
        forkSeq: 4,
        createdAt: '2026-11-11T10:02:00.000Z',
        lastActivityAt: '2026-11-11T10:03:00.000Z',
        status: 'active',
        turnCount: 3,
      },
    },
  };

  it('flattens branch hierarchy and triggers switch, create, and fold callbacks in SessionBranchPill', () => {
    const rows = flattenSessionBranchRows(sampleTree);
    expect(rows.map((r) => `${r.depth}:${r.branch.name}:${r.isActive}`)).toEqual([
      '0:main:false',
      '1:try-sqlite:true',
    ]);

    const onSwitchBranch = vi.fn();
    const onCreateBranch = vi.fn();
    const onFoldBranch = vi.fn();

    render(
      <SessionBranchPill
        tree={sampleTree}
        onSwitchBranch={onSwitchBranch}
        onCreateBranch={onCreateBranch}
        onFoldBranch={onFoldBranch}
      />,
    );

    const trigger = screen.getByTitle(/Session branch: try-sqlite \(2 total\)/i);
    fireEvent.click(trigger);

    // Switch back to main with keepFiles toggled on
    const keepCheckbox = screen.getByLabelText(/Keep files on switch/i);
    fireEvent.click(keepCheckbox);
    fireEvent.click(screen.getByText('main'));
    expect(onSwitchBranch).toHaveBeenCalledWith('main', { keepFiles: true });

    // Re-open and fold try-sqlite (default 1-arg fold)
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTitle(/Fold "try-sqlite" summary into parent/i));
    expect(onFoldBranch).toHaveBeenCalledWith('br_exp');

    // Re-open and fold active branch via "Fold insights into main" with note + keepOpen
    fireEvent.click(trigger);
    expect(screen.getByTestId('active-branch-fold-panel').textContent).toContain(
      'Fold insights into main',
    );
    fireEvent.click(screen.getByLabelText(/Keep open/i));
    fireEvent.change(screen.getByPlaceholderText('Optional fold note…'), {
      target: { value: 'SQLite WAL contention findings' },
    });
    fireEvent.click(screen.getByTestId('fold-active-branch-into-parent'));
    expect(onFoldBranch).toHaveBeenLastCalledWith('br_exp', {
      note: 'SQLite WAL contention findings',
      keepOpen: true,
    });

    // Re-open and create a new branch
    fireEvent.click(trigger);
    const input = screen.getByPlaceholderText('New branch name…');
    fireEvent.change(input, { target: { value: 'try-duckdb' } });
    fireEvent.submit(input.closest('form')!);
    expect(onCreateBranch).toHaveBeenCalledWith('try-duckdb');
  });

  it('renders all 9 PluginViewNode kinds and PluginStatusChipsBar cleanly', () => {
    const onSelectChip = vi.fn();
    render(
      <div>
        <PluginStatusChipsBar
          chips={[
            {
              qualifiedId: 'guard:canary',
              owner: 'guard',
              id: 'canary',
              text: 'canary:green',
              tone: 'success',
            },
            { qualifiedId: 'guard:lat', owner: 'guard', id: 'lat', text: 'p99:14ms', tone: 'info' },
          ]}
          maxVisible={1}
          onSelectChip={onSelectChip}
        />
        <PluginViewNodeRenderer
          node={{
            kind: 'stack',
            direction: 'vertical',
            gap: 2,
            children: [
              { kind: 'text', text: 'Deployment Overview', bold: true, tone: 'accent' },
              { kind: 'kv', items: [{ label: 'Region', value: 'eu-central-1', tone: 'info' }] },
              { kind: 'table', columns: ['Pod', 'State'], rows: [['api-1', 'Ready']] },
              { kind: 'badges', badges: [{ label: 'HEALTHY', tone: 'success' }] },
              { kind: 'progress', label: 'Rollout', current: 3, total: 4 },
              { kind: 'code', language: 'yaml', content: 'replicas: 4' },
              { kind: 'markdown', content: 'All probes passing.' },
              { kind: 'log', lines: [{ ts: '12:00', level: 'info', text: 'Rollout step 3/4' }] },
            ],
          }}
        />
      </div>,
    );

    expect(screen.getByText('canary:green')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    fireEvent.click(screen.getByText('canary:green'));
    expect(onSelectChip).toHaveBeenCalledTimes(1);

    expect(screen.getByText('Deployment Overview')).toBeTruthy();
    expect(screen.getByText('eu-central-1')).toBeTruthy();
    expect(screen.getByText('api-1')).toBeTruthy();
    expect(screen.getByText('HEALTHY')).toBeTruthy();
    expect(screen.getByText('75% (3/4)')).toBeTruthy();
    expect(screen.getByText('replicas: 4')).toBeTruthy();
    expect(screen.getByText('All probes passing.')).toBeTruthy();
    expect(screen.getByText('Rollout step 3/4')).toBeTruthy();
  });

  it('renders SessionRowStats branch badge and routes /tree, /panel, and /plugin in WebUI ChatInput', () => {
    render(
      <SessionRowStats
        isResuming={false}
        entry={{
          id: '2026-11-11/s1',
          title: 'Multi-branch session',
          startedAt: '2026-11-11T10:00:00.000Z',
          model: 'gpt-5',
          provider: 'openai',
          tokenTotal: 500,
          messageCount: 4,
          branchCount: 3,
          activeBranchName: 'try-cas',
          isCurrent: true,
        }}
      />,
    );
    expect(screen.getByTestId('session-row-branch-badge').textContent).toContain('try-cas (3)');

    // Slash autocomplete includes /tree, /panel, and /plugin
    expect(matchSlash('/tr').some((c) => c.name === '/tree')).toBe(true);
    expect(matchSlash('/pa').some((c) => c.name === '/panel')).toBe(true);
    expect(matchSlash('/plu').some((c) => c.name === '/plugin')).toBe(true);

    // Direct engine command dispatch works even on cold startup before command.catalog arrives
    const sentFrames: unknown[] = [];
    const mockClient = {
      send: (frame: unknown) => sentFrames.push(frame),
      on: () => () => {},
      withSession: <T extends Record<string, unknown>>(payload: T) => ({
        ...payload,
        sessionId: 'sess-tab-1',
      }),
    };

    const handled = runChatSlashCommand({
      raw: '/tree branch experiment-a',
      sessionId: 'sess-tab-1',
      addMessage: vi.fn(),
      clearMessages: vi.fn(),
      isLoading: false,
      client: mockClient as never,
      queue: [],
      sendAbort: vi.fn(),
      sendMsg: vi.fn(),
      setLoading: vi.fn(),
      setCurrentView: vi.fn(),
      toggleRefineEnabled: vi.fn(),
      setProcessMonitorOpen: vi.fn(),
      setQueuePanelOpen: vi.fn(),
      ws: {} as never,
      handleNextList: () => false,
      handleNextSelect: () => false,
    });

    expect(handled).toBe(true);
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toMatchObject({
      type: 'command.run',
      payload: {
        name: 'tree',
        args: 'branch experiment-a',
        sessionId: 'sess-tab-1',
      },
    });

    // Historical user turn rows render "Branch from here" and invoke onBranchFromPrompt(promptIndex)
    const onBranchFromPrompt = vi.fn();
    render(
      <ChatRowView
        row={{
          kind: 'user',
          key: 'u-1',
          message: {
            id: 'u-1',
            role: 'user',
            content: 'Explore Redis caching layer',
            timestamp: 1_700_000_000_000,
          },
        }}
        isLoading={false}
        compactMode={false}
        isFirstRow={false}
        groupToolCalls={true}
        sessionId="sess-tab-1"
        promptIndex={1}
        onBranchFromPrompt={onBranchFromPrompt}
      />,
    );
    fireEvent.click(screen.getByTestId('branch-from-prompt-1'));
    expect(onBranchFromPrompt).toHaveBeenCalledWith(1);

    // Historical & completed assistant turn rows also render "Branch from here"
    const onBranchAfterTurn = vi.fn();
    render(
      <ChatRowView
        row={{
          kind: 'agent',
          key: 'a-1',
          isLastTurn: false,
          items: [
            {
              kind: 'msg',
              key: 'a-1-msg',
              isFirst: true,
              isContinuation: false,
              message: {
                id: 'a-1-msg',
                role: 'assistant',
                content: 'Benchmarked Redis pipelining at 0.35ms p99.',
                timestamp: 1_700_000_001_000,
              },
            },
          ],
        }}
        isLoading={false}
        compactMode={false}
        isFirstRow={false}
        groupToolCalls={true}
        sessionId="sess-tab-1"
        branchAfterTurn={{ nextPromptIndex: 2 }}
        onBranchAfterTurn={onBranchAfterTurn}
      />,
    );
    fireEvent.click(screen.getByTestId('branch-after-turn-2'));
    expect(onBranchAfterTurn).toHaveBeenCalledWith(2);
  });
});

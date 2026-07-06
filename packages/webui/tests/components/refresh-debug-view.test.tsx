import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RefreshDebugView } from '../../src/components/RefreshDebugView';
import { useChatStore } from '../../src/stores/chat-store';
import { useSessionStore } from '../../src/stores/session-store';
import { useUIStore } from '../../src/stores/ui-store';

beforeEach(() => {
  useSessionStore.setState({
    session: null,
    projectName: '',
    projectRoot: '',
    cwd: '',
    mode: 'default',
    contextMode: 'balanced',
    lastVisitedAt: 0,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastInputTokens: 0,
    cost: 0,
    startTime: null,
    maxContext: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    modes: [],
    contextModes: [],
    iteration: null,
    todos: [],
  });
  useChatStore.setState({
    messages: [],
    queue: [],
    boundSessionId: null,
    currentAssistantMessageId: null,
    currentToolId: null,
    isLoading: false,
    abortController: null,
    executions: new Map(),
    toolMessageIdsByUseId: new Map(),
    runStart: null,
    thinkingBuffer: '',
    thinkingStartedAt: null,
    thinkingLogBuffer: '',
    thinkingLogStartedAt: null,
  });
  useUIStore.setState({
    currentView: 'refresh-debug' as const,
    dockSection: null,
    activeActivity: 'chat' as const,
    sidebarOpen: true,
    sidebarWidth: 304,
    pinnedIds: [],
    promptHistory: [],
    compactMode: false,
    favoriteSessionIds: [],
    sessionNicknames: {},
    fileExplorerWidth: 260,
    refineEnabled: false,
    workDashboardTab: 'todos' as const,
    inspectorOpen: false,
    inspectorTab: 'fleet' as const,
    hiddenChips: [],
    settingsOpen: false,
    showConfirmDialog: false,
    confirmInfo: null,
    paletteOpen: false,
    shortcutsOpen: false,
    searchOpen: false,
    searchQuery: '',
    searchActiveMessageId: null,
    scrollTarget: null,
    modelSwitcherOpen: false,
    dockCustomizeOpen: false,
    fleetMonitorOpen: false,
    agentsMonitorOpen: false,
    processMonitorOpen: false,
    queuePanelOpen: false,
    terminalOpen: false,
    skillsState: {
      selectedSkill: null,
      navHistory: [],
      historyIndex: -1,
      detailOpen: false,
      knownRefs: {},
      updateAvailableCount: 0,
    },
    selectedMailMessage: null,
  });
});

afterEach(() => {
  localStorage.clear();
});

describe('RefreshDebugView — F5 resilience verifier', () => {
  it('renders the page heading', () => {
    render(<RefreshDebugView />);
    expect(screen.getByText(/F5 Resilience Verifier/i)).toBeTruthy();
  });

  it('shows the no-session state when nothing is bound', () => {
    render(<RefreshDebugView />);
    expect(screen.getByText(/no session has been started yet/i)).toBeTruthy();
  });

  it('surfaces the active session id when one is set', () => {
    useSessionStore.getState().setSession({
      id: 'demo-sess',
      startedAt: 1_700_000_000_000,
      provider: 'anthropic',
      model: 'anthropic-test-model',
      title: 'Demo run',
    });
    render(<RefreshDebugView />);
    expect(screen.getAllByText(/demo-sess/).length).toBeGreaterThan(0);
  });

  it('shows the persisted env fields', () => {
    useSessionStore.setState({
      projectName: 'wrongstack-demo',
      cwd: '/tmp/wrongstack-demo/src',
      mode: 'plan',
      contextMode: 'deep',
    });
    render(<RefreshDebugView />);
    expect(screen.getByText('wrongstack-demo')).toBeTruthy();
    expect(screen.getByText('/tmp/wrongstack-demo/src')).toBeTruthy();
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('deep')).toBeTruthy();
  });

  it('flags cross-session bleed in red', () => {
    useSessionStore.getState().setSession({
      id: 'sess-LIVE',
      startedAt: 1_700_000_000_000,
      provider: 'anthropic',
      model: 'anthropic-test-model',
    });
    useChatStore.getState().setBoundSessionId('sess-DIFFERENT');
    useChatStore.setState({
      messages: [
        {
          id: 'm1',
          content: 'leaked from a different session',
          role: 'assistant' as const,
          timestamp: 1_700_000_000_000,
        },
      ],
    });
    render(<RefreshDebugView />);
    expect(screen.getByText(/No cross-session bleed/i)).toBeTruthy();
    expect(screen.getByText(/bound=sess-DIFFERENT vs active=sess-LIVE/)).toBeTruthy();
  });

  it('does NOT flag bleed when bound matches active', () => {
    useSessionStore.getState().setSession({
      id: 'sess-MATCH',
      startedAt: 1_700_000_000_000,
      provider: 'anthropic',
      model: 'anthropic-test-model',
    });
    useChatStore.getState().setBoundSessionId('sess-MATCH');
    useChatStore.setState({
      messages: [
        {
          id: 'm1',
          content: 'fine',
          role: 'user' as const,
          timestamp: 1_700_000_000_000,
        },
      ],
    });
    render(<RefreshDebugView />);
    expect(screen.getByText(/transcript binds to the active session/i)).toBeTruthy();
  });

  it('shows first/last message preview when transcript is non-empty', () => {
    useSessionStore.getState().setSession({
      id: 'sess-PREVIEW',
      startedAt: 1_700_000_000_000,
      provider: 'anthropic',
      model: 'anthropic-test-model',
    });
    useChatStore.getState().setBoundSessionId('sess-PREVIEW');
    useChatStore.setState({
      messages: [
        {
          id: 'a',
          content: 'first message body',
          role: 'user' as const,
          timestamp: 1,
        },
        {
          id: 'b',
          content: 'middle',
          role: 'assistant' as const,
          timestamp: 2,
        },
        {
          id: 'c',
          content: 'last message body',
          role: 'assistant' as const,
          timestamp: 3,
        },
      ],
    });
    render(<RefreshDebugView />);
    expect(screen.getAllByText(/first message body/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/last message body/).length).toBeGreaterThan(0);
  });

  it('reports the currentView + dockSection from localStorage round-trip', () => {
    useUIStore.getState().setCurrentView('chat');
    useUIStore.getState().setDockSection('work');
    render(<RefreshDebugView />);
    expect(screen.getAllByText('chat').length).toBeGreaterThan(0);
    expect(screen.getAllByText('work').length).toBeGreaterThan(0);
  });
});

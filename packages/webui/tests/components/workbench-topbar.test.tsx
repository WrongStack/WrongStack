import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchTopbar } from '../../src/components/WorkbenchTopbar';
import { type SubagentView, useFleetStore, useUIStore } from '../../src/stores';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (k: string, d?: string) => d ?? k,
  }),
}));

vi.mock('../../src/components/ThemeProvider', () => ({
  useTheme: () => ({
    theme: 'dark',
    setTheme: vi.fn(),
    palette: 'signal',
    setPalette: vi.fn(),
  }),
}));

/** Minimal fleet stub — session-less so it matches the no-active-session
 * filter in `agentBelongsToSession` without binding a chat lane. */
function fleetAgent(id: string, status: SubagentView['status'] = 'running'): SubagentView {
  return {
    id,
    name: id,
    status,
    iteration: 0,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: 1752750000000,
    toolLog: [],
    sparklineBins: [],
  };
}

function renderTopbar(currentView = 'chat') {
  return render(
    <WorkbenchTopbar
      currentView={currentView}
      projectName="TestProject"
      sessionLabel="Session Alpha"
      isLoading={false}
      iteration={null}
      onPalette={vi.fn()}
      onSettings={vi.fn()}
    />,
  );
}

describe('WorkbenchTopbar responsive component', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: false, activeActivity: 'chat', currentView: 'chat' });
    useFleetStore.setState({ agents: new Map() });
  });

  it('renders project name and view badge in both mobile and desktop viewports', () => {
    render(
      <WorkbenchTopbar
        currentView="chat"
        projectName="TestProject"
        sessionLabel="Session Alpha"
        isLoading={false}
        iteration={null}
        onPalette={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const projectLabels = screen.getAllByText('TestProject');
    expect(projectLabels.length).toBeGreaterThanOrEqual(1);

    const viewBadges = screen.getAllByText('Chat');
    expect(viewBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('triggers sidebar toggle from the mobile menu button', () => {
    renderTopbar();

    const menuBtn = screen.getByLabelText('Toggle navigation menu');
    expect(useUIStore.getState().sidebarOpen).toBe(false);

    fireEvent.click(menuBtn);
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it('renders the AGENTS trigger on every main view (compact + full headers)', () => {
    for (const view of ['chat', 'kanban', 'roster', 'sddhub', 'settings']) {
      const { unmount } = renderTopbar(view);
      // jsdom applies no CSS: both the <md compact header and the >=md full
      // header mount, so the shared top bar exposes the trigger twice.
      const triggers = screen.getAllByTestId('inspector-trigger');
      expect(triggers.length).toBe(2);
      unmount();
    }
  });

  it('title-area trigger keeps the agent count visible even with zero agents', () => {
    renderTopbar();

    const counts = screen.getAllByTestId('inspector-trigger').map((el) => el.textContent ?? '');
    // The desktop title-row placement passes showCountWhenZero, so one of the
    // two triggers renders a muted 0 badge instead of hiding the count.
    expect(counts.some((text) => text.includes('0'))).toBe(true);
  });

  it('shows the running-subagent count for the active session', () => {
    useFleetStore.setState({
      agents: new Map<string, SubagentView>([
        ['w1', fleetAgent('w1', 'running')],
        ['w2', fleetAgent('w2', 'completed')],
      ]),
    });
    renderTopbar();

    const counts = screen.getAllByTestId('inspector-trigger').map((el) => el.textContent ?? '');
    expect(counts.every((text) => text.includes('1'))).toBe(true);
  });

  it('opens the Agents side panel from the top bar while on another view', () => {
    renderTopbar('kanban');

    fireEvent.click(screen.getAllByTestId('inspector-trigger')[0]!);

    const ui = useUIStore.getState();
    expect(ui.sidebarOpen).toBe(true);
    expect(ui.activeActivity).toBe('agents');
    // The Agents panel pairs with the chat surface, so the view steers home.
    expect(ui.currentView).toBe('chat');
  });

  it('renders WrongProxy, HQ and WS indicators and triggers onSettings on click', () => {
    const onSettings = vi.fn();
    render(
      <WorkbenchTopbar
        currentView="chat"
        projectName="TestProject"
        sessionLabel="Session Alpha"
        isLoading={false}
        iteration={null}
        onPalette={vi.fn()}
        onSettings={onSettings}
      />,
    );

    const wrongProxyBtn = screen.getByTestId('wrongproxy-status-button');
    expect(wrongProxyBtn).toBeDefined();
    expect(wrongProxyBtn.getAttribute('title')).toContain('WrongProxy');

    const hqBtn = screen.getByTestId('hq-status-button');
    expect(hqBtn).toBeDefined();
    expect(hqBtn.getAttribute('title')).toContain('HQ');

    const wsIndicator = screen.getByTestId('ws-status-indicator');
    expect(wsIndicator).toBeDefined();

    fireEvent.click(wrongProxyBtn);
    expect(onSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(hqBtn);
    expect(onSettings).toHaveBeenCalledTimes(2);
  });
});

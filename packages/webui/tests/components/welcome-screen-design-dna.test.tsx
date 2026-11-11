import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
const sendMessage = vi.fn(() => 'msg_design_dna');
const showPanel = vi.fn();
const openMainView = vi.fn();
const client = {
  isConnected: true,
  on: vi.fn(() => () => undefined),
  send,
  sendMessage,
  listSavedProviders: vi.fn(),
};

vi.mock('@/lib/ws-client', () => ({ getWSClient: () => client }));
vi.mock('@/lib/view-navigation', () => ({ openMainView, showPanel }));
vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

const { WelcomeScreen } = await import('../../src/components/WelcomeScreen');
const { DesignReferenceCard } = await import(
  '../../src/components/MessageBubble/DesignReferenceCard'
);
const { useChatStore, useConfigStore } = await import('../../src/stores');
const { useFileStore } = await import('../../src/stores/file-store');
const { useLocalPrefs } = await import('../../src/stores/local-prefs');
const { useChatLanes } = await import('../../src/stores/chat-lanes');

beforeEach(() => {
  send.mockClear();
  sendMessage.mockClear();
  showPanel.mockClear();
  openMainView.mockClear();
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useConfigStore.setState({
    wsConnected: true,
    wsStatus: { state: 'open' },
    wsUrl: 'ws://test',
    provider: 'test-provider',
    model: 'test-model',
    savedProviders: [{ provider: 'test-provider', hasKey: true }] as never,
  });
  useLocalPrefs.setState({
    subagentsAllowed: true,
    subagentsPolicyLocked: false,
    chromeLevel: 'full',
  });
  useFileStore.setState({ tree: [] });
});

describe('WelcomeScreen Design DNA & DESIGN.md launcher', () => {
  it('launches a 6-page DESIGN.md extraction + web materialization prompt from the entry screen', () => {
    render(<WelcomeScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'linear.app' }));
    fireEvent.change(screen.getByLabelText('setup:welcome.design.workflowLabel'), {
      target: { value: 'materialize-web' },
    });
    fireEvent.click(screen.getByRole('button', { name: /setup:welcome\.design\.start/ }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const prompt = String((sendMessage.mock.calls[0] as unknown[] | undefined)?.[0] ?? '');
    expect(prompt).toContain('"url":"https://linear.app","maxPages":6');
    expect(prompt).toContain('"action":"materialize","stack":"web"');
    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({
        id: 'msg_design_dna',
        role: 'user',
        content: prompt,
      }),
    ]);
    expect(useChatStore.getState().isLoading).toBe(true);
  });

  it('opens Design Studio from the welcome shortcut', () => {
    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /setup:welcome\.design\.studioShortcut/ }));
    expect(showPanel).toHaveBeenCalledWith('design');
  });
});

describe('DesignReferenceCard live pipeline & completion actions', () => {
  it('highlights the active [3/4] stage while running and opens DESIGN.md when complete', () => {
    const events: string[] = [];
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<{ filePath?: string }>).detail;
      if (detail?.filePath) events.push(detail.filePath);
    };
    window.addEventListener('wrongstack:open-file', onOpen);

    try {
      const { rerender } = render(
        <DesignReferenceCard
          status="running"
          input={{ action: 'extract', url: 'https://stripe.com', maxPages: 6 }}
          progressLines={[
            '[1/4] Measuring https://stripe.com @ 1440×900px (breakpoint 5/5)…',
            '[3/4] Synthesizing Design DNA across 6 page(s) and 10 measurements…',
          ]}
        />,
      );

      expect(screen.getByTestId('design-reference-pipeline').textContent).toContain(
        '3. DNA Synthesis',
      );

      rerender(
        <DesignReferenceCard
          status="ok"
          input={{ action: 'extract', url: 'https://stripe.com', maxPages: 6 }}
          result={JSON.stringify({
            action: 'extract',
            reference: 'stripe-com',
            output:
              'Saved: .design/references/stripe-com/{dna.json,dna.md,DESIGN.md} (6 page(s) analyzed).\nFull 10-section DESIGN.md specification: .design/references/stripe-com/DESIGN.md',
          })}
        />,
      );

      expect(screen.getByText('.design/references/stripe-com/DESIGN.md')).toBeTruthy();
      expect(screen.getByText('6p · 5vp')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Open DESIGN\.md/ }));
      expect(events).toEqual(['.design/references/stripe-com/DESIGN.md']);
    } finally {
      window.removeEventListener('wrongstack:open-file', onOpen);
    }
  });
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileChangesButton } from '../src/file-changes-button.js';
import { useServerOutage } from '../src/hooks/use-server-outage.js';
import { playChime } from '../src/lib/chime.js';
import { splitSageBlock } from '../src/lib/sage-block.js';
import { OUTAGE_GRACE_MS, OUTAGE_PROBE_INTERVAL_MS } from '../src/lib/server-health.js';
import { ServerOutageOverlay } from '../src/server-outage-overlay.js';
import { SessionAgentStrip } from '../src/session-agent-strip.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function mount(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('small SimpleUI behavior surfaces', () => {
  it('splits only a valid trailing SAGE memory block', () => {
    const valid = [
      'tool output',
      '--- SAGE: related project knowledge (Memory Injector) ---',
      '- [project] <memory id="m1">Keep the owner singular.</memory>',
      '',
    ].join('\n');
    expect(splitSageBlock(valid)).toEqual({
      body: 'tool output',
      sageLines: [
        '--- SAGE: related project knowledge (Memory Injector) ---',
        '- [project] <memory id="m1">Keep the owner singular.</memory>',
      ],
    });
    expect(splitSageBlock('plain output')).toEqual({ body: 'plain output', sageLines: [] });
    expect(
      splitSageBlock('body\n--- SAGE: related project knowledge (Memory Injector) ---\ninvalid'),
    ).toEqual({
      body: 'body\n--- SAGE: related project knowledge (Memory Injector) ---\ninvalid',
      sageLines: [],
    });
  });

  it('plays and closes the two-note completion chime', () => {
    vi.useFakeTimers();
    const gains = Array.from({ length: 2 }, () => ({
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(function connect(this: unknown) {
        return this;
      }),
    }));
    const oscillators = Array.from({ length: 2 }, (_, index) => ({
      type: '',
      frequency: { value: 0 },
      connect: vi.fn(() => gains[index]),
      start: vi.fn(),
      stop: vi.fn(),
    }));
    let oscillatorIndex = 0;
    let gainIndex = 0;
    const close = vi.fn();
    const AudioContextMock = vi.fn(function AudioContextMock() {
      return {
        currentTime: 10,
        destination: {},
        createOscillator: vi.fn(() => oscillators[oscillatorIndex++]),
        createGain: vi.fn(() => gains[gainIndex++]),
        close,
      };
    });
    vi.stubGlobal('AudioContext', AudioContextMock);

    playChime();
    expect(AudioContextMock).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(300);
    expect(close).toHaveBeenCalledOnce();

    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => {
        throw new Error('blocked');
      }),
    );
    expect(() => playChime()).not.toThrow();
  });

  it('renders file-change totals and opens the collected diff set', () => {
    const files = [{ path: 'src/app.ts', added: 3, removed: 1 }] as never;
    const onOpenDiff = vi.fn();
    const empty = mount(
      <FileChangesButton
        fileCount={0}
        totalAdded={0}
        totalRemoved={0}
        files={[]}
        onOpenDiff={onOpenDiff}
      />,
    );
    expect(empty.querySelector('button')).toBeNull();

    const container = mount(
      <FileChangesButton
        fileCount={1}
        totalAdded={3}
        totalRemoved={1}
        files={files}
        onOpenDiff={onOpenDiff}
      />,
    );
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('1 file changed, +3 −1');
    act(() => button.click());
    expect(onOpenDiff).toHaveBeenCalledWith(files);
  });

  it('renders outage-specific guidance and dismisses the overlay', () => {
    const onDismiss = vi.fn();
    const empty = mount(<ServerOutageOverlay outage="none" onDismiss={onDismiss} />);
    expect(empty.textContent).toBe('');

    const gone = mount(<ServerOutageOverlay outage="server-gone" onDismiss={onDismiss} />);
    expect(gone.textContent).toContain('SimpleUI server is not reachable');
    expect(gone.textContent).toContain(window.location.host);
    act(() => (gone.querySelector('.outage-dismiss') as HTMLButtonElement).click());
    expect(onDismiss).toHaveBeenCalledOnce();

    const blocked = mount(<ServerOutageOverlay outage="ws-blocked" onDismiss={onDismiss} />);
    expect(blocked.textContent).toContain('WebSocket connection is failing');
  });

  it('supports live-agent selection and wrapped arrow navigation', () => {
    const onSelectAgent = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const container = mount(
      <SessionAgentStrip
        activeAgentId="leader"
        liveAgentTabs={[
          { id: 'leader', name: 'Leader', status: 'running', isLeader: true, isActive: true },
          {
            id: 'worker',
            name: 'Worker',
            status: 'busy',
            task: 'Audit routes',
            isLeader: false,
            isActive: true,
          },
        ]}
        finishedAgentTabs={[]}
        onSelectAgent={onSelectAgent}
      />,
    );
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    act(() => tabs[1]?.click());
    expect(onSelectAgent).toHaveBeenCalledWith('worker');
    act(() =>
      tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
    );
    expect(onSelectAgent).toHaveBeenLastCalledWith('worker');
  });
});

describe('useServerOutage', () => {
  beforeEach(() => vi.useFakeTimers());

  function renderHook(connection: 'open' | 'closed') {
    const captured = {
      current: undefined as unknown as ReturnType<typeof useServerOutage>,
    };
    function Probe() {
      captured.current = useServerOutage(connection);
      return null;
    }
    mount(<Probe />);
    return captured;
  }

  it('classifies a prolonged disconnect and resets dismissal after reopening', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const captured = renderHook('closed');
    expect(captured.current.outage).toBe('none');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTAGE_GRACE_MS);
    });
    expect(captured.current.outage).toBe('server-gone');
    act(() => captured.current.dismiss());
    expect(captured.current.dismissed).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTAGE_PROBE_INTERVAL_MS);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('stays healthy for an open connection', () => {
    const captured = renderHook('open');
    expect(captured.current).toMatchObject({ outage: 'none', dismissed: false });
  });
});

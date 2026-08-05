// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionTopbar, type SessionTopbarProps } from '../src/session-topbar.js';

const roots: Root[] = [];

function baseProps(overrides: Partial<SessionTopbarProps> = {}): SessionTopbarProps {
  return {
    session: {
      id: 'sess-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      projectName: 'WrongStack',
      cwd: 'D:/Codebox/PROJECTS/WrongStack',
      maxContext: 200000,
    },
    sessions: [],
    running: false,
    models: {
      selectedModel: 'claude-sonnet-4',
      groupedModels: [],
      providerLabels: {},
      pendingModelSwitch: null,
      selectModel: vi.fn(),
      confirmModelSwitch: vi.fn(),
    },
    contextTokens: 42000,
    contextMaxContext: 200000,
    load: 0.21,
    connection: 'open',
    theme: 'dark',
    commandPaletteOpen: false,
    mailboxOpen: false,
    mailboxUnreadCount: 0,
    settingsOpen: false,
    appVersion: '',
    latestVersion: '',
    hasUpdate: false,
    onCreateSession: vi.fn(),
    onResumeSession: vi.fn(),
    onRefreshSessions: vi.fn(),
    onOpenContextBreakdown: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onToggleTheme: vi.fn(),
    onToggleMailbox: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

function renderTopbar(props: SessionTopbarProps) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<SessionTopbar {...props} />));
  return host;
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('SessionTopbar context meter', () => {
  it('opens the context breakdown on click', () => {
    const props = baseProps();
    const host = renderTopbar(props);
    const meter = host.querySelector('.context-meter') as HTMLButtonElement;
    expect(meter).not.toBeNull();
    expect(meter.disabled).toBe(false);
    act(() => click(meter));
    expect(props.onOpenContextBreakdown).toHaveBeenCalledTimes(1);
  });

  it('stays enabled while a run is in progress (inspection is read-only)', () => {
    const props = baseProps({ running: true });
    const host = renderTopbar(props);
    const meter = host.querySelector('.context-meter') as HTMLButtonElement;
    expect(meter.disabled).toBe(false);
  });

  it('is disabled without a session', () => {
    const props = baseProps({ session: null });
    const host = renderTopbar(props);
    const meter = host.querySelector('.context-meter') as HTMLButtonElement;
    expect(meter.disabled).toBe(true);
  });

  it('advertises the details affordance and the new title', () => {
    const host = renderTopbar(baseProps());
    const meter = host.querySelector('.context-meter') as HTMLButtonElement;
    expect(host.querySelector('.context-details-hint')?.textContent).toBe('DETAILS');
    expect(meter.title).toContain('token breakdown');
    expect(host.querySelector('.context-compact-hint')).toBeNull();
  });
});

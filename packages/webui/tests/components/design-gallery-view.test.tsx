/**
 * Component test for DesignGalleryView — the gap the rest of the design suite
 * didn't cover: that the rendered gallery sends the right WS messages on mount
 * and on each button/interaction, renders kits, and surfaces the verify report.
 *
 * The WS client is mocked: `send` is captured, and registered `on(type, …)`
 * handlers are invoked manually to simulate server pushes.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sends: { type: string; payload?: unknown }[] = [];
const handlers: Record<string, (m: unknown) => void> = {};
const mockClient = {
  send: (m: { type: string; payload?: unknown }) => {
    sends.push(m);
  },
  // Every design message names the tab that sent it: the active kit is pinned
  // on that conversation's own context, so an unstamped pick re-styles the
  // leader's next turn instead.
  withSession: <T extends Record<string, unknown>>(p: T) => ({ ...p, sessionId: 'tab-1' }),
  on: (type: string, h: (m: unknown) => void) => {
    handlers[type] = h;
  },
  off: (type: string) => {
    delete handlers[type];
  },
};

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ client: mockClient }),
}));

import { DesignGalleryView } from '../../src/components/DesignGalleryView.js';
import { setActiveSessionLane } from '../../src/stores/session-lanes';

function emit(type: string, payload: unknown) {
  act(() => handlers[type]?.({ type, payload }));
}

const KIT = {
  id: 'kit-one',
  name: 'Kit One',
  aesthetic: 'Test aesthetic',
  bestFor: 'Testing',
  stacks: ['web'],
  tags: ['test'],
  light: { primary: 'oklch(62% 0.2 25)', bg: '#ffffff', fg: '#111111', accent: '#2244ff' },
  dark: { primary: 'oklch(70% 0.2 25)', bg: '#000000', fg: '#eeeeee', accent: '#88aaff' },
};

beforeEach(() => {
  sends.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('DesignGalleryView', () => {
  it('requests the kit list on mount and renders kits from design.list', () => {
    render(<DesignGalleryView />);
    expect(sends).toContainEqual({ type: 'design.list', payload: { sessionId: 'tab-1' } });
    emit('design.list', { kits: [KIT], activeKit: null, overrides: {} });
    expect(screen.getByText('Kit One')).toBeTruthy();
    expect(screen.getByText('kit-one')).toBeTruthy();
  });

  it('Use sends design.use with kit + stack', () => {
    render(<DesignGalleryView />);
    emit('design.list', { kits: [KIT], activeKit: null, overrides: {} });
    fireEvent.click(screen.getByText('Use'));
    expect(sends).toContainEqual({
      type: 'design.use',
      payload: { kit: 'kit-one', stack: 'web', sessionId: 'tab-1' },
    });
  });

  it('shows Materialize + Verify on the active kit and they send the right messages', () => {
    render(<DesignGalleryView />);
    emit('design.list', { kits: [KIT], activeKit: 'kit-one', overrides: {} });
    fireEvent.click(screen.getByText('Materialize'));
    expect(sends).toContainEqual({
      type: 'design.materialize',
      payload: { stack: 'web', sessionId: 'tab-1' },
    });
    fireEvent.click(screen.getByText('Verify'));
    expect(sends).toContainEqual({ type: 'design.verify', payload: { sessionId: 'tab-1' } });
  });

  it('a color picker change sends design.set with a theme-scoped override', () => {
    const { container } = render(<DesignGalleryView />);
    emit('design.list', { kits: [KIT], activeKit: 'kit-one', overrides: {} });
    const colorInput = container.querySelector('input[type="color"]') as HTMLInputElement | null;
    expect(colorInput).toBeTruthy();
    fireEvent.change(colorInput as HTMLInputElement, { target: { value: '#abcdef' } });
    const setMsg = sends.find((s) => s.type === 'design.set') as
      | { type: string; payload: { overrides: Record<string, string> } }
      | undefined;
    expect(setMsg).toBeTruthy();
    const keys = Object.keys(setMsg?.payload.overrides ?? {});
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^(light|dark)\./); // theme-scoped
    expect(Object.values(setMsg?.payload.overrides ?? {})[0]).toBe('#abcdef');
  });

  it('renders the verify report status', () => {
    render(<DesignGalleryView />);
    emit('design.list', { kits: [KIT], activeKit: 'kit-one', overrides: {} });
    emit('design.verify', { ok: true, score: 0.8, violationCount: 3, filesScanned: 5 });
    expect(screen.getByText(/80% on-palette/)).toBeTruthy();
    emit('design.verify', { ok: true, score: 1, violationCount: 0, filesScanned: 5 });
    expect(screen.getByText(/clean/)).toBeTruthy();
  });

  it('labels the verify status with its token basis — capture never reads as a kit score', () => {
    render(<DesignGalleryView />);
    emit('design.list', { kits: [KIT], activeKit: 'kit-one', overrides: {} });

    // Captured project tokens: the basis (and its source files) ride the status.
    emit('design.verify', {
      ok: true,
      score: 0.8,
      violationCount: 3,
      filesScanned: 5,
      source: 'captured',
      kit: null,
      capturedFrom: ['src/index.css'],
    });
    expect(screen.getByText(/80% on-palette/)).toBeTruthy();
    expect(screen.getByText(/captured tokens \(src\/index\.css\)/)).toBeTruthy();

    // Kit basis replaces it.
    emit('design.verify', {
      ok: true,
      score: 1,
      violationCount: 0,
      filesScanned: 5,
      source: 'kit',
      kit: 'minimal-clarity',
    });
    expect(screen.getByText(/kit minimal-clarity/)).toBeTruthy();
    expect(screen.queryByText(/captured tokens/)).toBeNull();
  });

  it('drops a late design.list that belongs to another tab', () => {
    act(() => setActiveSessionLane('tab-1'));
    render(<DesignGalleryView />);
    emit('design.list', {
      sessionId: 'tab-1',
      kits: [KIT],
      activeKit: 'kit-one',
      overrides: {},
    });
    expect(screen.getByText('Kit One')).toBeTruthy();

    // Switch tabs: the pointer moves instantly and the gallery re-subscribes
    // for tab-2. Tab-1's slow reply must not overwrite the view tab-2 holds.
    act(() => setActiveSessionLane('tab-2'));
    const other = { ...KIT, id: 'kit-two', name: 'Kit Two' };
    emit('design.list', {
      sessionId: 'tab-1',
      kits: [other],
      activeKit: 'kit-two',
      overrides: {},
    });
    expect(screen.queryByText('Kit Two')).toBeNull();
    // Untagged while a session is bound — a stale pre-session reply — dropped.
    emit('design.list', { kits: [other], activeKit: 'kit-two', overrides: {} });
    expect(screen.queryByText('Kit Two')).toBeNull();
    // Tab-2's own reply lands.
    emit('design.list', {
      sessionId: 'tab-2',
      kits: [other],
      activeKit: 'kit-two',
      overrides: {},
    });
    expect(screen.getByText('Kit Two')).toBeTruthy();

    act(() => setActiveSessionLane(null));
  });

  it('renders Material 3D axes, posture, photo treatment, and material summary when supplied', () => {
    render(<DesignGalleryView />);
    emit('design.list', {
      kits: [
        {
          ...KIT,
          id: 'atelier',
          name: 'Atelier',
          axes: { paper: 'light', display: 'roman-serif', accent: 'cool' },
          posture: 'restrained',
          photo: 'warm con=-6 vib=-10',
          material: 'limewash paper, deep umber ink, Sentient 300 over Hanken Grotesk',
        },
      ],
      activeKit: null,
      overrides: {},
    });
    expect(screen.getByText('light/roman-serif/cool')).toBeTruthy();
    expect(screen.getByText('restrained')).toBeTruthy();
    expect(screen.getByText('photo: warm con=-6 vib=-10')).toBeTruthy();
    expect(screen.getByText(/limewash paper, deep umber ink/)).toBeTruthy();
  });
});

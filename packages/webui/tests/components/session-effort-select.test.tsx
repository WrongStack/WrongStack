import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionEffortSelect } from '../../src/components/ChatInput/session-effort-select';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import { useSessionStore } from '../../src/stores/session-store';

const { updatePrefs } = vi.hoisted(() => ({ updatePrefs: vi.fn() }));

// The component pulls updatePrefs from the WS client hook; a stub keeps the
// write trip observable without a live socket.
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ updatePrefs }),
}));

// No i18n mock: the real module bundles the English catalog inline, so `t()`
// resolves synchronously and asserting on English labels is meaningful.

function effortSelect(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: 'Reasoning effort' }) as HTMLSelectElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  useLocalPrefs.setState({ reasoningEffort: 'high' });
  useSessionStore.setState({
    reasoningEffortLevels: undefined,
    effortSupported: undefined,
    projectReasoningEffort: undefined,
  });
});

afterEach(() => {
  cleanup();
});

describe('SessionEffortSelect (composer effort chip)', () => {
  it('leads with auto and narrows to the documented levels', () => {
    act(() => {
      useSessionStore.setState({ reasoningEffortLevels: ['low', 'high'] });
    });
    render(<SessionEffortSelect />);
    expect(Array.from(effortSelect().options).map((o) => o.value)).toEqual(['auto', 'low', 'high']);
    expect(effortSelect().value).toBe('high');
  });

  it('offers auto + the full canonical set for an undocumented vocabulary', () => {
    render(<SessionEffortSelect />);
    expect(Array.from(effortSelect().options).map((o) => o.value)).toEqual([
      'auto',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('renders nothing when the model documents that it has no effort control', () => {
    // Tri-state: `false` is a documented absence — hide the control entirely.
    // `undefined` (undocumented) keeps it visible with the full set.
    act(() => {
      useSessionStore.setState({ effortSupported: false });
    });
    const { container } = render(<SessionEffortSelect />);
    expect(container.innerHTML).toBe('');
  });

  it('writes the session-scoped pref through the paired set + prefs.update trip', () => {
    render(<SessionEffortSelect />);
    fireEvent.change(effortSelect(), { target: { value: 'auto' } });
    expect(useLocalPrefs.getState().reasoningEffort).toBe('auto');
    expect(updatePrefs).toHaveBeenCalledWith({ reasoningEffort: 'auto' });
  });

  it('hints the live project-wide effort while auto is picked', () => {
    act(() => {
      useLocalPrefs.setState({ reasoningEffort: 'auto' });
      useSessionStore.setState({ projectReasoningEffort: 'low' });
    });
    render(<SessionEffortSelect />);
    expect(screen.getByText('Project setting: Low')).toBeTruthy();
  });

  it('hides the project-effort hint for a concrete pick or an unset project value', () => {
    useSessionStore.setState({ projectReasoningEffort: 'low' });
    const { container } = render(<SessionEffortSelect />);
    // Concrete selection: no auto hint.
    expect(container.textContent).not.toContain('Project setting');

    // Auto picked, but the project pins no effort → nothing to show.
    act(() => {
      useLocalPrefs.setState({ reasoningEffort: 'auto' });
      useSessionStore.setState({ projectReasoningEffort: undefined });
    });
    expect(effortSelect().value).toBe('auto');
    expect(container.textContent).not.toContain('Project setting');
  });
});

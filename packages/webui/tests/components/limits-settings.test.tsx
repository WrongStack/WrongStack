import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimitsSection } from '../../src/components/SettingsPanel/LimitsSection';
import { useLocalPrefs } from '../../src/stores/local-prefs';

const original = useLocalPrefs.getState().limits;
afterEach(() => {
  cleanup();
  useLocalPrefs.getState().set({ limits: original });
});

function input(testId: string): HTMLInputElement {
  return screen.getByTestId(testId) as HTMLInputElement;
}

describe('LimitsSection', () => {
  it('shows every limit empty (= no limit) by default', () => {
    useLocalPrefs.getState().set({ limits: {} });
    render(<LimitsSection syncPref={vi.fn()} />);
    expect(input('limit-responseOutputTokens').value).toBe('');
    expect(input('limit-subagent-timeoutMs').value).toBe('');
  });

  it('commits on blur and sends the whole block, keeping the other limits', () => {
    useLocalPrefs.getState().set({ limits: { historyMessages: 400 } });
    const syncPref = vi.fn();
    render(<LimitsSection syncPref={syncPref} />);
    const field = input('limit-responseOutputTokens');
    fireEvent.change(field, { target: { value: '16000' } });
    expect(syncPref).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(syncPref).toHaveBeenCalledWith('limits', {
      historyMessages: 400,
      responseOutputTokens: 16000,
    });
  });

  it('clears a limit when the field is emptied', () => {
    useLocalPrefs.getState().set({ limits: { fetchBytes: 1000, historyMessages: 400 } });
    const syncPref = vi.fn();
    render(<LimitsSection syncPref={syncPref} />);
    const field = input('limit-fetchBytes');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(syncPref).toHaveBeenCalledWith('limits', { historyMessages: 400 });
  });

  it('writes subagent budget fields under subagentDefaultBudget and drops an empty budget', () => {
    useLocalPrefs.getState().set({ limits: { subagentDefaultBudget: { maxIterations: 40 } } });
    const syncPref = vi.fn();
    render(<LimitsSection syncPref={syncPref} />);
    const field = input('limit-subagent-maxIterations');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(syncPref).toHaveBeenCalledWith('limits', {});
  });

  it('does not send an invalid value', () => {
    useLocalPrefs.getState().set({ limits: {} });
    const syncPref = vi.fn();
    render(<LimitsSection syncPref={syncPref} />);
    const field = input('limit-historyMessages');
    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.blur(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(syncPref).not.toHaveBeenCalled();
  });
});

describe('LimitsSection bounds', () => {
  it('shows the allowed range under each input', () => {
    useLocalPrefs.getState().set({ limits: {} });
    render(<LimitsSection syncPref={vi.fn()} />);
    expect(screen.getByTestId('limit-historyMessages-range').textContent).toContain('≥ 20');
    expect(screen.getByTestId('limit-fetchBytes-range').textContent).toBe(
      '1,024 – 67,108,864 bytes',
    );
    expect(input('limit-fetchBytes').max).toBe('67108864');
  });

  it('refuses a value outside the range and says why', () => {
    useLocalPrefs.getState().set({ limits: {} });
    const syncPref = vi.fn();
    render(<LimitsSection syncPref={syncPref} />);
    const field = input('limit-historyMessages');
    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.blur(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Must be ≥ 20 messages/)).toBeTruthy();
    expect(syncPref).not.toHaveBeenCalled();
  });

  it('describes an invalid limit with its visible error', () => {
    useLocalPrefs.getState().set({ limits: {} });
    const syncPref = vi.fn();
    render(<LimitsSection syncPref={syncPref} />);
    const field = input('limit-historyMessages');

    // Control: the real field entered its invalid state and rendered the error.
    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.blur(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Must be ≥ 20 messages/)).toBeTruthy();

    const ids = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    const description = ids
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    expect(description).toContain('Must be ≥ 20 messages');
    expect(syncPref).not.toHaveBeenCalled();
  });
});

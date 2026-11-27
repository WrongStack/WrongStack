import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextModePicker } from '../../src/components/ContextModePicker';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ??
      {
        'activity:ctxMode.triggerTitle': 'Context-window mode',
        'activity:ctxMode.opsHeading': 'Context Operations',
        'activity:ctxMode.compactNow': 'Compact Now',
        'activity:ctxMode.ctxPrefix': 'Ctx',
      }[key] ??
      key,
  }),
}));

vi.mock('../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    listContextModes: vi.fn(),
    switchContextMode: vi.fn(),
    client: { compactContext: vi.fn(), repairContext: vi.fn() },
  }),
}));

vi.mock('../../src/stores', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ contextMode: 'balanced', contextModes: [] }),
}));

describe('ContextModePicker disclosure state', () => {
  afterEach(cleanup);

  it('keeps aria-expanded in sync with each popup trigger', () => {
    render(<ContextModePicker />);

    // Control: both real triggers rendered as native buttons with their titles.
    const modeTrigger = screen.getByTitle('Context-window mode');
    const opsTrigger = screen.getByTitle('Context Operations');
    expect(modeTrigger.tagName).toBe('BUTTON');
    expect(opsTrigger.tagName).toBe('BUTTON');
    expect(modeTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(opsTrigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(opsTrigger);
    // Control: the operations popup really opened before checking its state.
    expect(screen.getByText('Compact Now')).toBeTruthy();
    expect(opsTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(modeTrigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(modeTrigger);
    expect(modeTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(opsTrigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('dismisses the operations popup with Escape', () => {
    render(<ContextModePicker />);

    // Control: the real wrench trigger opened its operations popup.
    const opsTrigger = screen.getByTitle('Context Operations');
    fireEvent.click(opsTrigger);
    expect(screen.getByText('Compact Now')).toBeTruthy();
    expect(opsTrigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Compact Now')).toBeNull();
    expect(opsTrigger.getAttribute('aria-expanded')).toBe('false');
  });
});

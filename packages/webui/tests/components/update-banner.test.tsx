import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from '../../src/components/UpdateBanner';
import { useSessionStore } from '../../src/stores';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (k: string, d?: string) => d ?? k,
  }),
}));

describe('UpdateBanner component', () => {
  beforeEach(() => {
    localStorage.clear();
    useSessionStore.setState({
      appVersion: '0.313.0',
      latestVersion: '0.313.1',
      updateAvailable: true,
    });
  });

  it('renders update banner when updateAvailable is true', () => {
    render(<UpdateBanner />);

    expect(screen.getByText(/Update available: v0.313.0/)).toBeDefined();
    expect(screen.getByTitle('Refresh')).toBeDefined();
  });

  it('triggers window.location.reload when Refresh button is clicked', () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { reload: reloadMock },
    });

    render(<UpdateBanner />);

    const refreshBtn = screen.getByTitle('Refresh');
    fireEvent.click(refreshBtn);

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('detects new appVersion change and marks cache cleared with new build prompt', () => {
    localStorage.setItem('wrongstack_app_cached_version', '0.312.0');

    render(<UpdateBanner />);

    expect(screen.getByText(/New build ready/)).toBeDefined();
  });
});

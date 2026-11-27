import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '../../src/components/Toaster';
import { useNotificationStore } from '../../src/stores/notification-store';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string, fallback?: string) =>
      ({
        'activity:toaster.notifications': 'Notifications',
        'activity:toast.dismiss': 'Dismiss',
      })[key] ?? fallback ?? key,
  }),
}));

describe('Toaster live region', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], toasts: [], filter: 'important' });
  });
  afterEach(cleanup);

  it('mounts the aria-live container before any toast is pushed', () => {
    render(<Toaster />);

    expect(useNotificationStore.getState().toasts).toHaveLength(0);
    expect(screen.queryByText('Saved')).toBeNull();
    const emptyRegion = screen.queryByRole('region', { name: 'Notifications' });

    act(() => {
      useNotificationStore.setState({
        toasts: [{ id: 'toast-live-1', message: 'Saved', variant: 'success', ttl: 0 }],
      });
    });

    expect(screen.getByText('Saved')).toBeTruthy();
    const filledRegion = screen.getByRole('region', { name: 'Notifications' });
    expect(emptyRegion).toBeTruthy();
    expect(filledRegion).toBe(emptyRegion);
  });
});

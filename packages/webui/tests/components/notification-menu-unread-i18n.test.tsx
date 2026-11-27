import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationMenu } from '../../src/components/NotificationMenu';
import { useNotificationStore } from '../../src/stores/notification-store';

vi.mock('../../src/i18n', () => {
  const tr: Record<string, string> = {
    'toasts:menu.title': 'Bildirimler',
    'toasts:menu.unreadIndicator': 'Okunmamış göstergesi',
    'toasts:menu.unreadCount': '{{count}} okunmamış',
  };
  const t = (
    key: string,
    options?: string | ({ defaultValue?: string } & Record<string, unknown>),
  ) => {
    if (typeof options === 'string') return options;
    const value = tr[key];
    if (value !== undefined) {
      return Object.entries(options ?? {}).reduce(
        (text, [name, replacement]) =>
          name === 'defaultValue' ? text : text.replaceAll(`{{${name}}}`, String(replacement)),
        value,
      );
    }
    return options?.defaultValue ?? key;
  };
  return { useAppTranslation: () => ({ t }), i18n: { t } };
});

describe('NotificationMenu unread indicator localization', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], toasts: [], filter: 'important' });
  });
  afterEach(cleanup);

  it('names the unread dot with the active locale', () => {
    useNotificationStore.getState().push({
      message: 'Network unreachable',
      variant: 'error',
      ttl: 6000,
    });

    render(<NotificationMenu defaultOpen />);

    // Control: the real menu rendered the unread notification and its dot.
    expect(screen.getByText('Network unreachable')).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();

    expect(
      screen.getByRole('img', { name: 'Okunmamış göstergesi' }),
    ).toBeTruthy();
  });
});

/**
 * Desktop activity-rail icons expose their active state the same way the
 * mobile rail does: aria-pressed on the named button, not only via classes.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActivityIcon } from '@/components/activity-bar/activity-bar-utilities';

function mount(active: boolean) {
  return render(
    <ActivityIcon
      icon={<span aria-hidden="true">◆</span>}
      label="Chat"
      active={active}
      onClick={vi.fn()}
    />,
  );
}

describe('ActivityIcon active state', () => {
  it('renders a named button with the active visual indicator', () => {
    mount(true);
    const button = screen.getByRole('button', { name: 'Chat' });
    expect(button.title).toBe('Chat');
    expect(button.className).toContain('ws-nav-button-active');
  });

  it('exposes aria-pressed for active icons', () => {
    mount(true);
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('exposes aria-pressed for inactive icons', () => {
    mount(false);
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed')).toBe('false');
  });
});

/**
 * The custom-roster refresh control is icon-only, so its accessible name must
 * come from the shared action key rather than from the decorative icon.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string) => (key === 'common:action.refresh' ? 'Aktualisieren' : key),
  }),
}));

import { CustomRosterRoleList } from '../../src/components/CustomRosterParts.js';

const architect = {
  role: 'architect',
  exists: true,
  entryCount: 5,
  totalBytes: 1200,
  lastCapture: null,
  cooldownRemainingMs: 0,
  sessionCaptureCount: 1,
  needsSummarization: false,
  hasIdentity: true,
  hasConfig: true,
  hasKnowledge: false,
};

function mount(onRefresh = vi.fn()) {
  render(
    <CustomRosterRoleList
      roles={[architect]}
      selectedRole={null}
      setSelectedRole={vi.fn()}
      onRefresh={onRefresh}
    />,
  );
  return onRefresh;
}

describe('CustomRosterRoleList accessible names', () => {
  it('renders the roster heading and role row', () => {
    mount();
    expect(screen.getByText('activity:customRoster.heading')).toBeTruthy();
    expect(screen.getByRole('button', { name: /architect/ })).toBeTruthy();
  });

  it('names the icon-only refresh button in the active locale', () => {
    const onRefresh = mount();
    const refresh = screen.getByRole('button', { name: 'Aktualisieren' });
    expect(refresh.getAttribute('aria-label')).toBe('Aktualisieren');
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

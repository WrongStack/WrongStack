import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActivityBar } from '../../src/components/activity-bar';
import { useUIStore } from '../../src/stores';
import { useLocalPrefs } from '../../src/stores/local-prefs';

describe('Mobile activity bar', () => {
  beforeEach(() => {
    useLocalPrefs.setState({ chromeLevel: 'calm' });
    useUIStore.setState({ currentView: 'chat', activeActivity: 'chat', sidebarOpen: false });
  });

  it('opens the files workspace from the bottom navigation', () => {
    render(<ActivityBar />);
    const navigation = screen.getByTestId('mobile-activity-bar');

    fireEvent.click(within(navigation).getByRole('button', { name: 'Files' }));

    expect(useUIStore.getState().currentView).toBe('files');
    expect(useUIStore.getState().activeActivity).toBe('files');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(within(navigation).getByTestId('mobile-activity-bar-tools-launcher')).toBeTruthy();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchTopbar } from '../../src/components/WorkbenchTopbar';
import { useUIStore } from '../../src/stores';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (k: string, d?: string) => d ?? k,
  }),
}));

vi.mock('../../src/components/ThemeProvider', () => ({
  useTheme: () => ({
    theme: 'dark',
    setTheme: vi.fn(),
    palette: 'signal',
    setPalette: vi.fn(),
  }),
}));

describe('WorkbenchTopbar responsive component', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: false });
  });

  it('renders project name and view badge in both mobile and desktop viewports', () => {
    render(
      <WorkbenchTopbar
        currentView="chat"
        projectName="TestProject"
        sessionLabel="Session Alpha"
        isLoading={false}
        iteration={null}
        onPalette={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const projectLabels = screen.getAllByText('TestProject');
    expect(projectLabels.length).toBeGreaterThanOrEqual(1);

    const viewBadges = screen.getAllByText('Chat');
    expect(viewBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('triggers sidebar toggle from the mobile menu button', () => {
    render(
      <WorkbenchTopbar
        currentView="chat"
        projectName="TestProject"
        sessionLabel="Session Alpha"
        isLoading={false}
        iteration={null}
        onPalette={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const menuBtn = screen.getByLabelText('Toggle navigation menu');
    expect(useUIStore.getState().sidebarOpen).toBe(false);

    fireEvent.click(menuBtn);
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });
});

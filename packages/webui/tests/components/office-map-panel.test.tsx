import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeMapPanel } from '../../src/components/OfficeMapPanel';
import { useOfficeMapStore } from '../../src/stores/office-map-store';

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      ({
        'activity:agentOffice.office': 'Office',
        'activity:agentOffice.topology': 'Topology',
        'activity:agentOffice.officeDescription': 'Live agent desks and work',
        'activity:agentOffice.topologyDescription': 'Clients, agents and connections',
      })[key] ?? key,
  }),
}));

vi.mock('@wrongstack/project-surfaces/lib/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      ({
        'activity:agentOffice.office': 'Office',
        'activity:agentOffice.topology': 'Topology',
        'activity:agentOffice.officeDescription': 'Live agent desks and work',
        'activity:agentOffice.topologyDescription': 'Clients, agents and connections',
      })[key] ?? key,
  }),
}));

vi.mock('@wrongstack/project-surfaces/office/AgentOfficeView', () => ({
  AgentOfficeView: () => <div>Office content</div>,
}));

vi.mock('@wrongstack/project-surfaces/office/OfficeMapCanvas', () => ({
  OfficeMapCanvas: () => <div>Topology content</div>,
}));

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
}));

describe('OfficeMapPanel view navigation', () => {
  beforeEach(() => {
    useOfficeMapStore.setState({ viewMode: 'office' });
  });

  afterEach(cleanup);

  it('keeps both primary tabs visible while switching views', () => {
    render(<OfficeMapPanel />);

    const officeTab = screen.getByRole('tab', { name: /Office/ });
    const topologyTab = screen.getByRole('tab', { name: /Topology/ });
    expect(officeTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Office content')).toBeTruthy();

    fireEvent.click(topologyTab);

    expect(topologyTab.getAttribute('aria-selected')).toBe('true');
    expect(officeTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText('Topology content')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('supports arrow-key navigation between the tabs', () => {
    render(<OfficeMapPanel />);

    const officeTab = screen.getByRole('tab', { name: /Office/ });
    const topologyTab = screen.getByRole('tab', { name: /Topology/ });
    fireEvent.keyDown(officeTab, { key: 'ArrowRight' });

    expect(topologyTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(topologyTab);
  });
});

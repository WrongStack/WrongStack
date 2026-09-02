/**
 * Lazy view router. Each surface is its own chunk so opening the Cockpit does
 * not download React Flow, Monaco-sized markdown pipelines or the QR encoder.
 */
import { type ComponentType, lazy, type LazyExoticComponent } from 'react';
import type { HqViewId } from '../../data/store/index.js';

export const HQ_VIEW_COMPONENTS: Record<HqViewId, LazyExoticComponent<ComponentType>> = {
  cockpit: lazy(() => import('../../views/cockpit.js').then((m) => ({ default: m.CockpitView }))),
  fleet: lazy(() =>
    import('../../views/fleet/index.js').then((m) => ({ default: m.FleetMapView })),
  ),
  console: lazy(() =>
    import('../../views/console/index.js').then((m) => ({ default: m.LiveConsoleView })),
  ),
  mailbox: lazy(() =>
    import('../../views/mailbox/index.js').then((m) => ({ default: m.MailboxView })),
  ),
  kanban: lazy(() =>
    import('../../views/kanban/index.js').then((m) => ({ default: m.KanbanView })),
  ),
  alerts: lazy(() => import('../../views/alerts.js').then((m) => ({ default: m.AlertsView }))),
  cost: lazy(() => import('../../views/cost.js').then((m) => ({ default: m.CostView }))),
  trends: lazy(() => import('../../views/trends.js').then((m) => ({ default: m.TrendsView }))),
  brain: lazy(() => import('../../views/brain.js').then((m) => ({ default: m.BrainView }))),
  worktree: lazy(() =>
    import('../../views/worktree.js').then((m) => ({ default: m.WorktreeView })),
  ),
  control: lazy(() =>
    import('../../views/control/index.js').then((m) => ({ default: m.ControlView })),
  ),
  settings: lazy(() =>
    import('../../views/settings/index.js').then((m) => ({ default: m.SettingsView })),
  ),
};

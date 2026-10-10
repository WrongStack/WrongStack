/**
 * Sidebar twins of the workspace F-key panels. Each twin lives in its own
 * `sidebar-panel-<name>.tsx` module; this barrel keeps the historical import
 * path stable for `sidebar-panels.tsx` and tests.
 */

export { AgentsPanelSidebar } from './sidebar-panel-agents.js';
export { ConnectionsPanelSidebar } from './sidebar-panel-connections.js';
export { CoordinatorPanelSidebar } from './sidebar-panel-coordinator.js';
export { FleetPanelSidebar } from './sidebar-panel-fleet.js';
export { ProjectPickerSidebar } from './sidebar-panel-project.js';
export { WorktreePanelSidebar } from './sidebar-panel-worktree.js';
export { WrongProxyPanelSidebar } from './sidebar-panel-wrong-proxy.js';

/**
 * HQ host plane: what a host process needs to be steerable from HQ — its connection (kept
 * pointed at the live config, owning the project's Kanban/SAGE sync), the command dispatcher,
 * the fleet controls and the WebUI command handler. One implementation for the CLI and the
 * standalone engine behind WebUI/desktop.
 */

export * from './hq-host/acp-config.js';
export * from './hq-host/command-controller.js';
export * from './hq-host/connection.js';
export * from './hq-host/fleet-control.js';
export * from './hq-host/kanban-hq-sync.js';
export * from './hq-host/sage-hq-sync.js';
export * from './hq-host/webui-command-handler.js';

export const IPC = {
  getState: 'desktop:get-state',
  getConversation: 'desktop:get-conversation',
  getWebuiStatus: 'desktop:get-webui-status',
  getOpenSessions: 'desktop:get-open-sessions',
  openProject: 'desktop:open-project',
  registerProject: 'desktop:register-project',
  unregisterProject: 'desktop:unregister-project',
  openProjectSession: 'desktop:open-project-session',
  activateRuntime: 'desktop:activate-runtime',
  closeRuntime: 'desktop:close-runtime',
  navigateWebui: 'desktop:navigate-webui',
  reloadWebui: 'desktop:reload-webui',
  setShellSidebarCollapsed: 'desktop:set-shell-sidebar-collapsed',
  openSettings: 'desktop:open-settings',
  sendMessage: 'desktop:send-message',
  abortRuntime: 'desktop:abort-runtime',
  openRuntimeInBrowser: 'desktop:open-runtime-in-browser',
  revealRuntimeRoot: 'desktop:reveal-runtime-root',
  stateChanged: 'desktop:state-changed',
  conversationChanged: 'desktop:conversation-changed',
  webuiStatusChanged: 'desktop:webui-status-changed',
  webuiReadyChanged: 'desktop:webui-ready-changed',
  webuiPrefsChanged: 'desktop:webui-prefs-changed',
  webuiOpenSessionsChanged: 'desktop:webui-open-sessions-changed',
  openSessionsChanged: 'desktop:open-sessions-changed',
  webuiCommandAck: 'desktop:webui-command-ack',
  webuiCommand: 'desktop:webui-command',
  shellSidebarCollapsedChanged: 'desktop:shell-sidebar-collapsed-changed',
  setLocale: 'desktop:set-locale',
  localeChanged: 'desktop:locale-changed',
  // Embedded WebUI view side — the desktop shell pushes locale changes here
  // so the React WebUI inside Electron can swap i18n instantly, without waiting
  // for the config-file watcher → WS prefs.updated round-trip.
  webuiLocaleChanged: 'desktop:webui-locale-changed',
  // macOS open-file event forwarded from main process to shell renderer.
  // The shell uses this to decide whether to open a dragged/double-clicked
  // path as a project directory.
  openFile: 'desktop:open-file',
} as const;

/**
 * `@wrongstack/runtime/plugin-host` — the plugin set and user hooks every host
 * loads. The CLI and the standalone WebUI server (the desktop engine) both call
 * `setupPlugins` and `installHostHooks`, so the built-in plugins, the plugin
 * enablement gates, the external-plugin trust gate and `config.hooks` behave
 * the same on every surface.
 */
export * from './plugin-host/external-plugins.js';
export * from './plugin-host/host-hooks.js';
export * from './plugin-host/plugin-llm.js';
export * from './plugin-host/plugin-quiescence.js';
export * from './plugin-host/setup-plugins.js';
export * from './plugin-host/ts-module-loader.js';

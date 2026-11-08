/**
 * External (third-party) plugin loading moved to `@wrongstack/runtime/plugin-host`
 * so the standalone WebUI host (the desktop engine) loads plugins through the
 * same TOFU trust gate as the CLI. Re-exported here for existing CLI importers.
 */
export {
  type ExternalPluginTrustMode,
  hashPluginClosure,
  loadExternalPlugins,
  normalizeConfigPath,
  resolveExternalPluginTrustMode,
  resolveSpecifierEntry,
} from '@wrongstack/runtime/plugin-host';

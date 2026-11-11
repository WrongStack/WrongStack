import {
  type ManagedPluginHostHandle,
  type PluginsWiringDeps,
  setupPlugins as setupHostPlugins,
} from '@wrongstack/runtime/plugin-host';
import createApi from '../plugin-api-factory.js';

// The plugin set, its enablement gates and the external-plugin trust gate live
// in `@wrongstack/runtime/plugin-host`, shared with the standalone WebUI host
// (the desktop engine). Re-exported here for existing CLI importers.
export {
  _resetDeprecatedWarningsForTests,
  BUILTIN_PLUGIN_FACTORIES,
  BUILTIN_PLUGIN_NAME_HINTS,
  builtinPluginNameFromSpec,
  DEPRECATED_PLUGIN_NAMES,
  type ExternalPluginReloadReport,
  type ManagedPluginHostHandle,
  type PluginsWiringDeps,
  pluginNameFromSpec,
  warnIfDeprecatedPluginName,
} from '@wrongstack/runtime/plugin-host';

/** The CLI host's plugin setup: the shared loader with the CLI's plugin API factory. */
export function setupPlugins(
  params: PluginsWiringDeps,
): Promise<ManagedPluginHostHandle | undefined> {
  return setupHostPlugins({ ...params, apiFactory: params.apiFactory ?? createApi });
}

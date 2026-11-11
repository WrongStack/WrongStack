import type {
  PluginAPI,
  PluginCapabilities,
  PluginDependency,
} from '@wrongstack/contracts/types/plugin';
import type { JSONSchema } from '@wrongstack/contracts/types/tool';
import { resolvePluginManifestConfig } from './config.js';
import { KERNEL_API_VERSION } from './loader.js';

/**
 * Define a plugin with automatic `apiVersion` injection and optional
 * TypeScript type inference for the plugin options schema.
 *
 * The `options` generic is inferred from the `factory` function's second
 * parameter, so annotating it gives you fully-typed options throughout:
 *
 * @example
 * ```ts
 * import { definePlugin } from '@wrongstack/core';
 *
 * interface MyOptions {
 *   threshold: number;
 *   enabled: boolean;
 * }
 *
 * const myPlugin = definePlugin(
 *   {
 *     name: 'my-plugin',
 *     version: '0.1.0',
 *     description: 'My example plugin',
 *     capabilities: { tools: true },
 *     configSchema: {
 *       type: 'object',
 *       properties: {
 *         threshold: { type: 'number', default: 100 },
 *         enabled: { type: 'boolean', default: true },
 *       },
 *     },
 *     defaultConfig: { threshold: 100, enabled: true },
 *   },
 *   (api, options) => {
 *     // options.threshold is `number` here, not `unknown`
 *     api.tools.register({
 *       name: 'my-tool',
 *       description: `Threshold is ${options.threshold}`,
 *       // ...
 *     });
 *   },
 * );
 *
 * export default myPlugin;
 * ```
 *
 * Plugins that don't need typed options can omit the interface and let
 * TypeScript infer from `defaultConfig`, or omit `defaultConfig` entirely
 * (options will be `undefined` at runtime, accessible via `api.config`):
 *
 * @example
 * ```ts
 * const simplePlugin = definePlugin(
 *   { name: 'simple' },
 *   (api) => {
 *     api.tools.register({ name: 'ping', description: 'Ping the service' });
 *   },
 * );
 * ```
 *
 * The `apiVersion` is automatically set to the current `KERNEL_API_VERSION`
 * so plugins are always compatible with the kernel that loaded them.
 * Plugins that need to pin to a specific kernel version can override it
 * in the returned object before exporting.
 */
export function definePlugin<const TOptions extends Record<string, unknown> | undefined>(
  metadata: {
    name: string;
    version?: string | undefined;
    description?: string | undefined;
    capabilities?: PluginCapabilities | undefined;
    configSchema?: JSONSchema | undefined;
    defaultConfig?: TOptions | undefined;
    dependsOn?: (string | PluginDependency)[] | undefined;
    optionalDeps?: (string | PluginDependency)[] | undefined;
    conflictsWith?: string[] | undefined;
  },
  factory: (api: PluginAPI, options: TOptions) => void | Promise<void>,
): {
  name: string;
  version?: string | undefined;
  description?: string | undefined;
  apiVersion: string;
  capabilities?: PluginCapabilities | undefined;
  configSchema?: JSONSchema | undefined;
  defaultConfig?: TOptions | undefined;
  dependsOn?: (string | PluginDependency)[] | undefined;
  optionalDeps?: (string | PluginDependency)[] | undefined;
  conflictsWith?: string[] | undefined;
  setup: (api: PluginAPI) => void | Promise<void>;
} {
  return {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    capabilities: metadata.capabilities,
    configSchema: metadata.configSchema,
    defaultConfig: metadata.defaultConfig,
    dependsOn: metadata.dependsOn,
    optionalDeps: metadata.optionalDeps,
    conflictsWith: metadata.conflictsWith,
    apiVersion: KERNEL_API_VERSION,
    // Cast the factory to match the Plugin.setup signature.
    // The opts parameter ({ signal }) is accepted by Plugin.setup but the
    // definePlugin factory doesn't need to declare it — the host always passes
    // it at the call site; the factory just doesn't have to care about it.
    setup: (api: PluginAPI) => {
      const resolved = resolvePluginManifestConfig(
        {
          name: metadata.name,
          ...(metadata.defaultConfig !== undefined
            ? { defaultConfig: metadata.defaultConfig as Record<string, unknown> }
            : {}),
        },
        api?.config,
      );
      const options = (
        metadata.defaultConfig !== undefined || resolved.configured ? resolved.options : undefined
      ) as TOptions;
      return factory(api, options);
    },
  };
}

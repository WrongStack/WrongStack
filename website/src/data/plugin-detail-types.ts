// Per-plugin detail data for the plugin detail pages.
// Generated from packages/plugins/src/*/index.ts, packages/core/src/plugins/*,
// packages/plug-lsp, packages/telegram, and packages/plugins/README.md.
// Keys match pluginCatalog entry names in ./runtime-catalog.ts.

export interface PluginToolParam {
  name: string;
  type: string;
  description?: string;
}

export interface PluginToolDetail {
  name: string;
  category?: string;
  mutating?: boolean;
  permission?: string;
  summary?: string;
  params?: PluginToolParam[];
}

export interface PluginConfigOption {
  name: string;
  type: string;
  defaultValue?: string;
  description?: string;
}

export interface PluginDetail {
  version?: string;
  longDescription: string;
  tools: PluginToolDetail[];
  configOptions: PluginConfigOption[];
  hooks: string[];
  dependsOn?: string[];
  apiVersion?: string;
  example?: string;
}

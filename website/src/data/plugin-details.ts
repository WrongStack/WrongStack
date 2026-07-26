// Per-plugin detail data for the plugin detail pages.
// Generated from packages/plugins/src/*/index.ts, packages/core/src/plugins/*,
// packages/plug-lsp, packages/telegram, and packages/plugins/README.md.
// Keys match pluginCatalog entry names in ./runtime-catalog.ts.

import type { PluginDetail } from './plugin-detail-types';
import { pluginDetailsPart1 } from './plugin-details-part-1';
import { pluginDetailsPart2 } from './plugin-details-part-2';
import { pluginDetailsPart3 } from './plugin-details-part-3';
import { pluginDetailsPart4 } from './plugin-details-part-4';
import { pluginDetailsPart5 } from './plugin-details-part-5';
import { pluginDetailsPart6 } from './plugin-details-part-6';

export type {
  PluginToolParam,
  PluginToolDetail,
  PluginConfigOption,
  PluginDetail,
} from './plugin-detail-types';

export const pluginDetails: Record<string, PluginDetail> = {
  ...pluginDetailsPart1,
  ...pluginDetailsPart2,
  ...pluginDetailsPart3,
  ...pluginDetailsPart4,
  ...pluginDetailsPart5,
  ...pluginDetailsPart6,
};

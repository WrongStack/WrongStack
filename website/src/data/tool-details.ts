// Per-tool detail data for the built-in tool detail pages.
// Generated from the real tool definitions in @wrongstack/tools (name, description,
// inputSchema, selection boundaries). Detail entries are optional: ToolDetailPage
// falls back to the toolCatalog summary and empty params/notes sections when a
// tool has no entry here. Currently 57 of the 70 catalog tools have entries;
// the remainder render summary-only pages. When adding an entry, derive every
// field (params, notes, boundaries) from the tool's runtime source — never
// compose from memory.

import type { ToolDetail } from './tool-detail-types';
import { toolDetailsPart1 } from './tool-details-part-1';
import { toolDetailsPart2 } from './tool-details-part-2';
import { toolDetailsPart3 } from './tool-details-part-3';
import { toolDetailsPart4 } from './tool-details-part-4';

export type { ToolParamDetail, ToolDetail } from './tool-detail-types';

export const toolDetails: Record<string, ToolDetail> = {
  ...toolDetailsPart1,
  ...toolDetailsPart2,
  ...toolDetailsPart3,
  ...toolDetailsPart4,
};

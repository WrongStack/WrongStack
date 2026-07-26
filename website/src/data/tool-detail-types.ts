// Per-tool detail data for the built-in tool detail pages.
// Generated from the real tool definitions in @wrongstack/tools (name, description,
// inputSchema, selection boundaries). Keys match runtime-catalog.ts toolCatalog names.

export interface ToolParamDetail {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}

export interface ToolDetail {
  longDescription: string;
  params: ToolParamDetail[];
  doNotUseWhen?: string[];
  useInstead?: string[];
  notes?: string[];
}

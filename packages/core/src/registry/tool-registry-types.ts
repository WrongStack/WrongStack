import type { Tool, ToolWrapper } from '@wrongstack/contracts/types/tool';

export type { ToolWrapper };

/** One layer of a tool's registration stack (base tool or a wrapper over it). */
export interface ToolRegistration {
  tool: Tool;
  owner: string;
  previous?: ToolRegistration;
  wrapper?: ToolWrapper;
  wrapperOwner?: string;
  removed?: boolean;
}

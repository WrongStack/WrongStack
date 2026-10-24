/** Values the agent pipelines (`userInput`, `toolCall`) thread through middleware. */
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from './blocks.js';
import type { AgentContext, AgentRunContext } from './context.js';
import type { Tool } from './tool.js';

/** Value threaded through the `userInput` pipeline before a run starts. */
export interface UserInputPayload {
  content: ContentBlock[];
  text: string;
  ctx: AgentRunContext;
}

/** Value threaded through the `toolCall` pipeline after each tool settles. */
export interface ToolCallPipelinePayload {
  toolUse: ToolUseBlock;
  result: ToolResultBlock;
  ctx: AgentContext;
  tool?: Tool | undefined;
}

/**
 * Agent type definitions — extracted from agent.ts to break circular
 * dependencies and keep the Agent class focused on runtime logic.
 */

import type { ExtensionRegistry } from '../extension/registry.js';
import type { Container } from '../kernel/container.js';
import type { EventBus } from '../kernel/events.js';
import { Pipeline } from '../kernel/pipeline.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { ContentBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { LoopDetectionConfig } from '../types/config.js';
import type { WrongStackError } from '../types/errors.js';
import type { Tracer } from '../types/observability.js';
import type { PermissionPolicy } from '../types/permission.js';
import type { Request, Response } from '../types/provider.js';
import type { Tool } from '../types/tool.js';
import type { ToolExecutorLike } from '../types/tool-executor.js';
import type { Context } from './context.js';

/** Default iteration cap. Use 0 or Infinity via config to disable. */
export const DEFAULT_MAX_ITERATIONS = 100;

export interface RunResult {
  status: 'done' | 'failed' | 'max_iterations' | 'aborted';
  error?: WrongStackError | undefined;
  finalText?: string | undefined;
  iterations: number;
  delegateSummaries?: Array<{ summary: string | undefined; ok: boolean }>;
  /** Human-readable reason for abort (e.g. "user interrupt", "tool timeout", "stream hang"). */
  abortReason?: string | undefined;
}

export interface AgentInit {
  container: Container;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  events: EventBus;
  pipelines: AgentPipelines;
  context: Context;
  maxIterations?: number | undefined;
  iterationTimeoutMs?: number | undefined;
  executionStrategy?: 'parallel' | 'sequential' | 'smart' | undefined;
  perIterationOutputCapBytes?: number | undefined;
  autoExtendLimit?: boolean | undefined;
  autonomousContinue?: boolean | undefined;
  /** Rebuild the host system prompt from the live direct/catalog tool surfaces before each run. */
  refreshSystemPrompt?: boolean | undefined;
  confirmAwaiter?: import('../types/tool-executor.js').ConfirmAwaiter | undefined;
  permissionPolicy?: PermissionPolicy | undefined;
  tracer?: Tracer | undefined;
  extensions?: ExtensionRegistry | undefined;
  toolExecutor: ToolExecutorLike;
  /** Loop-detector tuning (`tools.loopDetection`). Omitted fields use defaults. */
  loopDetection?: LoopDetectionConfig | undefined;
}

/** Fully-resolved loop-detector settings (defaults applied, bounds clamped). */
export interface ResolvedLoopDetectionConfig {
  mode: 'steer-then-cut' | 'cut' | 'off';
  steerThreshold: number;
  cutThreshold: number;
  windowSize: number;
  callRepeatThreshold: number;
}

/**
 * Apply defaults and sanity bounds to a (possibly partial) loop-detection
 * config. Clamping keeps a bad config from disabling the safety valve by
 * accident: the cut threshold always sits strictly above the steer
 * threshold so 'steer-then-cut' can never cut before it has steered.
 */
export function resolveLoopDetection(cfg?: LoopDetectionConfig): ResolvedLoopDetectionConfig {
  const steerThreshold = Math.max(2, cfg?.steerThreshold ?? 3);
  return {
    mode: cfg?.mode ?? 'steer-then-cut',
    steerThreshold,
    cutThreshold: Math.max(steerThreshold + 1, cfg?.cutThreshold ?? steerThreshold + 2),
    windowSize: Math.max(4, cfg?.windowSize ?? 12),
    callRepeatThreshold: Math.max(2, cfg?.callRepeatThreshold ?? 4),
  };
}

export interface AgentPipelines {
  request: Pipeline<Request>;
  response: Pipeline<Response>;
  toolCall: Pipeline<ToolCallPipelinePayload>;
  userInput: Pipeline<UserInputPayload>;
  assistantOutput: Pipeline<TextBlock>;
  contextWindow: Pipeline<Context>;
}

export interface UserInputPayload {
  content: ContentBlock[];
  text: string;
  ctx: Context;
}

export type AgentInput = string | ContentBlock[];

export function normalizeInput(input: AgentInput): { blocks: ContentBlock[]; text: string } {
  if (typeof input === 'string') {
    return { blocks: [{ type: 'text', text: input }], text: input };
  }
  const text = input
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
  return { blocks: input, text };
}

export interface ToolCallPipelinePayload {
  toolUse: ToolUseBlock;
  result: ToolResultBlock;
  ctx: Context;
  tool?: Tool | undefined;
}

export function createDefaultPipelines(): AgentPipelines {
  return {
    request: new Pipeline<Request>(),
    response: new Pipeline<Response>(),
    toolCall: new Pipeline<ToolCallPipelinePayload>(),
    userInput: new Pipeline<UserInputPayload>(),
    assistantOutput: new Pipeline<TextBlock>(),
    contextWindow: new Pipeline<Context>(),
  };
}

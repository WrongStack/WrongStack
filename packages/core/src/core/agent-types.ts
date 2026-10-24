/**
 * Agent type definitions — extracted from agent.ts to break circular
 * dependencies and keep the Agent class focused on runtime logic.
 */

import type { Container } from '@wrongstack/contracts/kernel/container';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { Pipeline, type PipelineErrorHandler } from '@wrongstack/contracts/kernel/pipeline';
import type { ContentBlock, TextBlock } from '@wrongstack/contracts/types/blocks';
import { isTextBlock } from '@wrongstack/contracts/types/blocks';
import type { LoopDetectionConfig } from '@wrongstack/contracts/types/config';
import type { Tracer } from '@wrongstack/contracts/types/observability';
import type { PermissionPolicy } from '@wrongstack/contracts/types/permission';
import type {
  ToolCallPipelinePayload,
  UserInputPayload,
} from '@wrongstack/contracts/types/pipeline-payloads';
import type { Request, Response } from '@wrongstack/contracts/types/provider';
import type { RunResult } from '@wrongstack/contracts/types/run-result';
import type { ToolExecutorLike } from '@wrongstack/contracts/types/tool-executor';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { Context } from './context.js';

/** Default iteration cap. Use 0 or Infinity via config to disable. */
export const DEFAULT_MAX_ITERATIONS = 100;
/**
 * How many times a single run may auto-grant itself +100 extra iterations
 * when `autoExtendLimit` is on. The grant exists so a task that slightly
 * overruns its budget still finishes; without a ceiling it silently turned
 * every configured `maxIterations` into no limit at all, because nothing
 * ever denies the grant.
 */
export const DEFAULT_MAX_AUTO_EXTENSIONS = 3;

export type { RunResult };

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
  maxAutoExtensions?: number | undefined;
  autonomousContinue?: boolean | undefined;
  /** Rebuild the host system prompt from the live direct/catalog tool surfaces before each run. */
  refreshSystemPrompt?: boolean | undefined;
  confirmAwaiter?: import('@wrongstack/contracts/types/tool-executor').ConfirmAwaiter | undefined;
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

export type { UserInputPayload };

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

export type { ToolCallPipelinePayload };

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

/**
 * The host error boundary for an agent's pipelines. A middleware that throws is
 * logged and reported as an `error` event; a plugin's is then swallowed (it and
 * the chain below it are skipped for that value) and a core one rethrown.
 * Without it a plugin's crash fails the whole turn.
 */
export function installPipelineErrorBoundaries(
  pipelines: AgentPipelines,
  deps: { events: EventBus; logger: { error(message: string, err?: unknown): void } },
): void {
  const all: Array<{ setErrorHandler(handler: PipelineErrorHandler): unknown }> = [
    pipelines.request,
    pipelines.response,
    pipelines.toolCall,
    pipelines.userInput,
    pipelines.assistantOutput,
    pipelines.contextWindow,
  ];
  for (const pipeline of all) {
    pipeline.setErrorHandler((ev) => {
      const fromPlugin = !!ev.owner && ev.owner !== 'core';
      deps.logger.error(
        `Pipeline middleware "${ev.middleware}" crashed (owner=${ev.owner ?? 'unknown'}); ${fromPlugin ? 'swallowed' : 'rethrown'}`,
        ev.err,
      );
      deps.events.emit('error', {
        err: ev.err instanceof Error ? ev.err : new Error(String(ev.err)),
        phase: `pipeline:${ev.middleware}`,
      });
      return fromPlugin ? 'swallow' : 'rethrow';
    });
  }
}

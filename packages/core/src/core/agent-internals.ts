import type { Container } from '@wrongstack/contracts/kernel/container';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { ErrorHandler } from '@wrongstack/contracts/types/error-handler';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { PermissionPolicy } from '@wrongstack/contracts/types/permission';
import type { Renderer } from '@wrongstack/contracts/types/renderer';
import type { RetryPolicy } from '@wrongstack/contracts/types/retry-policy';
import type { ToolExecutorLike } from '@wrongstack/contracts/types/tool-executor';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { AgentPipelines, ResolvedLoopDetectionConfig } from './agent-types.js';
import type { Context } from './context.js';

/**
 * Minimal interface exposing the Agent fields that the extracted
 * loop / tool-execution / response modules need. Each extracted
 * function takes this interface instead of the full Agent class,
 * keeping coupling explicit and testable.
 */
export interface AgentInternals {
  readonly container: Container;
  readonly tools: ToolRegistry;
  readonly providers: ProviderRegistry;
  readonly events: EventBus;
  readonly pipelines: AgentPipelines;
  readonly ctx: Context;
  readonly maxIterations: number;
  readonly executionStrategy: 'parallel' | 'sequential' | 'smart';
  readonly perIterationOutputCapBytes: number;
  readonly autoExtendLimit: boolean;
  readonly maxAutoExtensions: number;
  readonly loopDetection: ResolvedLoopDetectionConfig;
  readonly toolExecutor: ToolExecutorLike;
  readonly extensions: ExtensionRegistry;
  readonly logger: Logger;
  readonly retry: RetryPolicy;
  readonly errorHandler: ErrorHandler;
  readonly permission: PermissionPolicy;
  readonly renderer: Renderer | undefined;
  readonly tracer: import('@wrongstack/contracts/types/observability').Tracer | undefined;
}

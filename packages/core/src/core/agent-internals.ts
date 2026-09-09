import type { ExtensionRegistry } from '../extension/registry.js';
import type { Container } from '../kernel/container.js';
import type { EventBus } from '../kernel/events.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { ErrorHandler } from '../types/error-handler.js';
import type { Logger } from '../types/logger.js';
import type { PermissionPolicy } from '../types/permission.js';
import type { Renderer } from '../types/renderer.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { ToolExecutorLike } from '../types/tool-executor.js';
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
  readonly tracer: import('../types/observability.js').Tracer | undefined;
}

/**
 * Per-request architecture-decision (ADR) context for the agent loop.
 *
 * The ADR registry and its bounded read-only checker live in core's storage
 * layer; the request builders in core's agent loop may not import storage
 * runtime values. The loop depends on this port and resolves it from the
 * container (`ARCHITECTURE_DECISION_CONTEXT`); `createDefaultContainer` in
 * `@wrongstack/runtime` binds the storage-backed implementation. Unbound
 * means no ADR blocks reach the request.
 *
 * @module types/architecture-decision-context
 */
import type { TextBlock } from './blocks.js';
import type { AgentContext } from './context.js';
import type { PermissionPolicy } from './permission.js';
import type { Tool } from './tool.js';

/** Minimal logger shape; the request builders pass their agent's logger. */
export interface ArchitectureDecisionContextLogger {
  warn(message: string): void;
}

export interface ArchitectureDecisionContextPort {
  /**
   * The live snapshot of accepted decisions, or `undefined` when there is
   * nothing to say. Records `architectureDecisionSnapshot` in `meta`. A
   * broken registry degrades to no block.
   */
  buildDecisionBlock(
    projectRoot: string,
    meta: Record<string, unknown>,
    logger?: ArchitectureDecisionContextLogger,
  ): TextBlock | undefined;
  /**
   * Host-computed results of the accepted decisions' declared checks.
   * `getPermission` is called only when an accepted decision has checks; a
   * missing or throwing policy yields a blocked result, never a throw.
   */
  buildChecksBlock(
    ctx: AgentContext,
    getPermission: () => Pick<PermissionPolicy, 'explain'> | undefined,
    readTool?: Tool,
  ): Promise<TextBlock | undefined>;
}

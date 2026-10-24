/**
 * State, output settlement plumbing and the permission gate of the
 * {@link ToolExecutor} (tool-executor.ts), which runs batches through them.
 */

import type { ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type {
  ToolResultRenderMode,
  ToolResultRenderModeConfig,
} from '@wrongstack/contracts/types/config';
import type { HookInput } from '@wrongstack/contracts/types/hooks';
import type { Tool } from '@wrongstack/contracts/types/tool';
import type {
  ToolConfirmPendingResult,
  ToolExecutionOutput,
} from '@wrongstack/contracts/types/tool-executor';
import { type Context, resolveEventSessionId } from '../core/context.js';
import { capabilityDowngradesToConfirm } from '../security/capabilities.js';
import { describeWriteTargets } from '../security/permission-helpers.js';
import {
  approvalRecord,
  DEFAULT_ALWAYS_TRUST_TTL_MS,
  isPersistentApproval,
  userRuleAnswer,
} from '../security/scoped-approval.js';
import { createToolOutputSerializer } from '../utils/tool-output-serializer.js';
import { resolveToolResultRenderMode } from '../utils/tool-result-render-mode.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import type { KanbanBoundaryResult, PreExecutionValidationResult } from './tool-executor-guard.js';
import {
  logToolFailure as logToolFailureEvent,
  logToolSuccess as logToolSuccessEvent,
} from './tool-executor-logging.js';
import type { ToolExecutorOptions } from './tool-executor-options.js';
import { deniedResult } from './tool-executor-results.js';
import { hashPermissionInput } from './tool-executor-support.js';
import {
  budgetForString as budgetForStringFromHost,
  produceToolOutput as produceToolOutputFromHost,
  runWithTimeout as runWithTimeoutFromHost,
  settleToolOutput as settleToolOutputFromHost,
  type ToolOutputSettlementHost,
} from './tool-output-settlement.js';

/** Outcome of {@link ToolExecutorCore.authorizeToolUse}. */
export type ToolUseAuthorization =
  | { kind: 'run' }
  /** The call is settled; `charge` is result text that counts against the iteration budget. */
  | { kind: 'done'; output: ToolExecutionOutput; charge?: string | undefined };

export abstract class ToolExecutorCore {
  /** Minimum gap between coalesced `partial_output` tool.progress emits. */
  static readonly PROGRESS_EMIT_INTERVAL_MS = 100;
  /** Max chars of accumulated stream text carried per coalesced emit (tail). */
  static readonly PROGRESS_TAIL_CHARS = 16_384;
  /** Max chars of the head (beginning of output) kept alongside the tail. */
  static readonly PROGRESS_HEAD_CHARS = 16_384;

  protected readonly serializer;
  protected readonly iterationTimeoutMs: number;
  protected readonly maxToolTimeoutMs: number;
  protected readonly maxParallelTools: number;

  constructor(
    protected readonly registry: { get(name: string): Tool | undefined; list(): Tool[] },
    protected opts: ToolExecutorOptions,
  ) {
    this.iterationTimeoutMs = opts.iterationTimeoutMs ?? 300_000;
    this.maxToolTimeoutMs = opts.maxToolTimeoutMs ?? 300_000;
    const requestedParallelism = opts.maxParallelTools ?? 4;
    this.maxParallelTools = Number.isFinite(requestedParallelism)
      ? Math.max(1, Math.min(16, Math.floor(requestedParallelism)))
      : 4;
    this.serializer = createToolOutputSerializer({
      perIterationOutputCapBytes: opts.perIterationOutputCapBytes ?? 100_000,
    });
  }

  clearConfirmAwaiter(): void {
    this.opts.confirmAwaiter = undefined;
  }

  protected hintRenderMode(toolName: string): void {
    const renderer = this.opts.renderer;
    if (!renderer || typeof renderer.setResultRenderMode !== 'function') return;
    const modes: ToolResultRenderModeConfig | undefined = this.opts.resultRenderModes;
    const mode: ToolResultRenderMode = resolveToolResultRenderMode(modes, toolName);
    renderer.setResultRenderMode(toolName, mode);
  }

  protected logToolSuccess(
    ctx: Context,
    use: ToolUseBlock,
    toolName: string,
    durationMs: number,
    outputChars: number,
  ): void {
    logToolSuccessEvent(this.opts, ctx, use, toolName, durationMs, outputChars);
  }

  protected logToolFailure(
    ctx: Context,
    use: ToolUseBlock,
    toolName: string,
    durationMs: number,
    err: unknown,
  ): void {
    logToolFailureEvent(this.opts, ctx, use, toolName, durationMs, err);
  }
  /**
   * Permission gate for one call: policy evaluation, capability downgrade,
   * Kanban boundary, the `permission.evaluated` event and the confirm prompt.
   */
  protected async authorizeToolUse(
    tool: Tool,
    use: ToolUseBlock,
    ctx: Context,
    preToolContext: PreExecutionValidationResult['preToolContext'],
    boundary: KanbanBoundaryResult | { decision: 'allow'; reason?: undefined; path?: undefined },
    start: number,
  ): Promise<ToolUseAuthorization> {
    const decision = await this.opts.permissionPolicy.evaluate(tool, use.input, ctx);
    let effectivePermission = decision.permission;
    const policy = this.opts.permissionPolicy;
    const yolo = policy.yoloModeFor?.(ctx).yolo ?? policy.getYolo?.() === true;
    // A trust-file `auto` must not widen into arbitrary dangerous-capability
    // execution, so it still confirms below. YOLO, an explicit
    // `--allowed-tools` grant and an approval the user gave at a confirm
    // prompt are the user's own decisions; without the waiver
    // `--allowed-tools write` re-prompted (in a script, with nobody to
    // answer, the write was simply denied) and "always allow" never stuck.
    const capabilityDowngraded = capabilityDowngradesToConfirm(decision, tool, yolo);
    if (capabilityDowngraded) {
      effectivePermission = 'confirm';
    }

    // YOLO+ never asks; a boundary DENY was already returned by the guard.
    if (boundary.decision === 'confirm' && effectivePermission !== 'deny' && !decision.allowAll) {
      effectivePermission = 'confirm';
    }

    this.opts.events?.emit('permission.evaluated', {
      sessionId: resolveEventSessionId(ctx),
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      ...(ctx.activeLogicalRequestId ? { logicalRequestId: ctx.activeLogicalRequestId } : {}),
      ...(ctx.activePromptManifestId ? { promptManifestId: ctx.activePromptManifestId } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      name: tool.name,
      id: use.id,
      inputHash: hashPermissionInput(use.input, this.opts.secretScrubber),
      policyDecision: decision.permission,
      effectiveDecision: effectivePermission,
      decisionSource: decision.source,
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...((decision.riskTier ?? tool.riskTier)
        ? { riskTier: decision.riskTier ?? tool.riskTier }
        : {}),
      yoloEnabled: yolo,
      boundaryDecision: boundary.decision,
      ...(boundary.reason ? { boundaryReason: boundary.reason } : {}),
      capabilityDowngraded,
      taskId: ctx.currentKanbanTaskId,
      boardId: ctx.currentKanbanBoardId,
      ...(typeof ctx.provider === 'object'
        ? { provider: (ctx.provider as { id: string }).id }
        : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
    });

    if (effectivePermission === 'deny') {
      const result = deniedResult(use, decision.reason);
      await this.toolSkipped(tool, use, ctx, String(result.content));
      return {
        kind: 'done',
        output: { result, tool, durationMs: Date.now() - start, settlement: 'denied_by_policy' },
        charge: result.content,
      };
    }

    if (effectivePermission === 'confirm') {
      const suggestedPattern =
        boundary.decision === 'confirm'
          ? `kanban-boundary:${boundary.path ?? tool.name}`
          : (subjectForToolInput(tool.name, use.input, tool.subjectKey, tool.subjectFields) ??
            tool.name);
      // VULN-001 Phase 2: real destinations from Tool.writeTargets so the
      // confirm payload shows what the call would write, not `directory: "."`.
      const writeTargets = describeWriteTargets(tool, use.input);
      if (this.opts.confirmAwaiter) {
        const awaiter = this.opts.confirmAwaiter;
        const answer = await new Promise<
          | 'yes'
          | 'no'
          | 'always'
          | 'always-exact'
          | 'always-command'
          | 'always-tool'
          | 'deny'
          | 'abort'
        >((resolve, reject) => {
          const signal = ctx.signal;
          const onAbort = () => resolve('abort');
          if (signal.aborted) {
            resolve('abort');
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          awaiter(tool, use.input, use.id, suggestedPattern).then(
            (c) => {
              signal.removeEventListener('abort', onAbort);
              resolve(c);
            },
            (e) => {
              signal.removeEventListener('abort', onAbort);
              reject(e);
            },
          );
        });
        const choice = userRuleAnswer(answer, decision.source);
        if (isPersistentApproval(choice)) {
          const approval = approvalRecord(choice, tool, use.input, ctx, suggestedPattern);
          await this.opts.permissionPolicy.trust({
            tool: tool.name,
            pattern: approval.pattern,
            ttlMs: DEFAULT_ALWAYS_TRUST_TTL_MS,
          });
          this.opts.events?.emit('trust.persisted', {
            sessionId: resolveEventSessionId(ctx),
            tool: tool.name,
            ...approval,
            decision: 'always',
          });
        }
        if (choice !== 'yes' && !isPersistentApproval(choice)) {
          const result = {
            type: 'tool_result' as const,
            tool_use_id: use.id,
            content:
              choice === 'abort'
                ? `Tool "${tool.name}" was not executed — the run was aborted while awaiting confirmation.`
                : `Tool "${tool.name}" denied by user.`,
            is_error: true,
          };
          await this.toolSkipped(tool, use, ctx, result.content);
          return {
            kind: 'done',
            output: {
              result,
              tool,
              durationMs: Date.now() - start,
              settlement: choice === 'abort' ? 'aborted' : 'declined',
            },
            charge: result.content,
          };
        }
      } else {
        const pending: ToolConfirmPendingResult = {
          type: 'tool_confirm_pending',
          toolUseId: use.id,
          toolName: tool.name,
          input: use.input,
          ...(preToolContext ? { preToolContext } : {}),
          suggestedPattern,
          decisionSource: decision.source,
          riskTier: decision.riskTier ?? tool.riskTier,
          ...(writeTargets.length > 0 ? { writeTargets } : {}),
          ...(boundary.decision === 'confirm' && boundary.reason
            ? { boundaryReason: boundary.reason }
            : {}),
        };
        return { kind: 'done', output: { result: pending, tool, durationMs: Date.now() - start } };
      }
    }
    return { kind: 'run' };
  }

  /** Audit + live `file.event` for a successful file-capable call. */
  protected emitToolFileEvent(
    tool: Tool,
    use: ToolUseBlock,
    ctx: Context,
    inputPath: string,
    absPath: string,
    caps: readonly string[],
    writeTargetExisted: boolean | undefined,
    start: number,
  ): void {
    const operation =
      tool.name === 'read'
        ? 'read'
        : caps.includes('fs.write') && tool.name === 'write'
          ? writeTargetExisted === false
            ? 'create'
            : 'update'
          : caps.includes('fs.write')
            ? 'update'
            : 'read';
    const ts = new Date().toISOString();
    ctx.recordFileEvent?.({
      operation,
      filePath: inputPath,
      absPath,
      toolName: tool.name,
      toolUseId: use.id,
      durationMs: Date.now() - start,
    });
    this.opts.events?.emit('file.event', {
      operation,
      filePath: inputPath,
      absPath,
      sessionId: resolveEventSessionId(ctx),
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      provider:
        typeof ctx.provider === 'object'
          ? (ctx.provider as { id: string }).id
          : String(ctx.provider),
      model: ctx.model,
      ...(ctx.activeLogicalRequestId ? { logicalRequestId: ctx.activeLogicalRequestId } : {}),
      ...(ctx.activePromptManifestId ? { promptManifestId: ctx.activePromptManifestId } : {}),
      provenanceConfidence:
        ctx.activeLogicalRequestId && ctx.activePromptManifestId ? 'explicit' : 'unknown',
      toolName: tool.name,
      toolUseId: use.id,
      scope: ctx.currentKanbanTaskId ? 'task' : 'session',
      taskId: ctx.currentKanbanTaskId,
      boardId: ctx.currentKanbanBoardId,
      timestamp: ts,
      durationMs: Date.now() - start,
    });
  }

  /**
   * PreToolUse ran for this call but the tool will not run (denied, rejected,
   * aborted, threw). Lets claim-releasing PostToolUse hooks undo what
   * PreToolUse took; see `HookRegistrationOptions.runWhenToolSkipped`.
   */
  async abandonTool(tool: Tool, use: ToolUseBlock, ctx: Context, reason: string): Promise<void> {
    await this.toolSkipped(tool, use, ctx, reason);
  }

  protected async toolSkipped(
    tool: Tool,
    use: ToolUseBlock,
    ctx: Context,
    reason: string,
  ): Promise<void> {
    try {
      await this.opts.hookRunner?.toolSkipped(tool.name, use.input, reason, ctx);
    } catch {
      // Cleanup only; the call already has its result.
    }
  }

  protected async produceToolOutput(
    tool: Tool,
    use: ToolUseBlock,
    ctx: Context,
    budgetHint: number,
  ): Promise<{
    text: string;
    fingerprint: string;
    data?: { value: unknown };
    writePaths: Pick<
      NonNullable<HookInput['toolResult']>,
      'modifiedPaths' | 'modifiedPathsOmitted'
    >;
  }> {
    return produceToolOutputFromHost(this.toolOutputSettlementHost(), tool, use, ctx, budgetHint);
  }

  protected settleToolOutput(
    tool: Tool,
    use: ToolUseBlock,
    text: string,
    budget: number,
  ): { block: ToolResultBlock; bytes: number } {
    return settleToolOutputFromHost(this.toolOutputSettlementHost(), tool, use, text, budget);
  }

  protected async runWithTimeout(
    tool: Tool,
    input: unknown,
    parentSignal: AbortSignal,
    ctx: Context,
    toolUseId?: string | undefined,
  ): Promise<unknown> {
    return runWithTimeoutFromHost(
      this.toolOutputSettlementHost(),
      tool,
      input,
      parentSignal,
      ctx,
      toolUseId,
    );
  }

  protected budgetForString(content: string, budget: number): number {
    return budgetForStringFromHost(this.toolOutputSettlementHost(), content, budget);
  }

  protected toolOutputSettlementHost(): ToolOutputSettlementHost {
    const owner = this;
    return {
      get opts() {
        return owner.opts;
      },
      set opts(value) {
        owner.opts = value;
      },
      runWithTimeout: (...args) => owner.runWithTimeout(...args),
      serializer: owner.serializer,
      hintRenderMode: (...args) => owner.hintRenderMode(...args),
      iterationTimeoutMs: owner.iterationTimeoutMs,
      maxToolTimeoutMs: owner.maxToolTimeoutMs,
      PROGRESS_EMIT_INTERVAL_MS: ToolExecutorCore.PROGRESS_EMIT_INTERVAL_MS,
      PROGRESS_TAIL_CHARS: ToolExecutorCore.PROGRESS_TAIL_CHARS,
      PROGRESS_HEAD_CHARS: ToolExecutorCore.PROGRESS_HEAD_CHARS,
    };
  }
}

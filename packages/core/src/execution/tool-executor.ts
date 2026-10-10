import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { areSubagentsAllowed } from '../coordination/session-subagent-policy.js';
import type { Context } from '../core/context.js';
import { queueDirectoryInstructions } from '../core/project-instructions.js';
import { spanSessionAttributes } from '../core/span-session.js';
import {
  hasCapability,
  hasDangerousCapabilityForSubagents,
  ToolCapabilities,
} from '../security/capabilities.js';
import { describeWriteTargets } from '../security/permission-helpers.js';
import {
  pendingRequiredSkills,
  REQUIRED_SKILLS_LOADER_TOOL,
  requiredSkillsDeniedMessage,
} from '../skills/required-skill-gate.js';
import { skillSpeedBump } from '../skills/skill-speed-bump.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import { isWrongStackError } from '../types/errors.js';
import type { Tool } from '../types/tool.js';
import {
  GOVERNED_TOOL_EXECUTOR_META_KEY,
  type GovernedToolExecutor,
  type ToolBatchResult,
  type ToolExecutionOutput,
  type ToolExecutorStrategy,
} from '../types/tool-executor.js';
import { toErrorMessage } from '../utils/error.js';
import { rememberProgrammaticOutput } from '../utils/tool-programmatic-output.js';
import {
  appendToolResultContext,
  fingerprintText,
  rememberToolResultFingerprint,
} from '../utils/tool-result-fingerprint.js';
import { toolErrorResult } from './tool-error-taxonomy.js';
import { ToolExecutorCore } from './tool-executor-core.js';
import { validateToolInputAndHooks } from './tool-executor-guard.js';
import { deniedResult, toolInputCorrection, unknownToolResult } from './tool-executor-results.js';
import { classifyToolError } from './tool-executor-support.js';

export { classifyToolError } from './tool-executor-support.js';

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await run(items[index]!);
    }
  };
  // `Math.min` PROPAGATES NaN, so a non-finite `limit` would yield
  // `Array.from({ length: NaN })` — ZERO workers, `Promise.all([])` resolves
  // immediately, and NO tool ever runs: every entry of `results` is left a hole
  // and the iteration silently reports zero tool calls. The constructor
  // normalizes `maxParallelTools` before it reaches here, so this is
  // defense-in-depth for any future caller — matching the identical guard in
  // `storage/storage-concurrency.ts`, `tools/_concurrency.ts` and
  // `bench/src/runner.ts`.
  const effectiveLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  await Promise.all(Array.from({ length: Math.min(effectiveLimit, items.length) }, () => worker()));
  return results;
}

type BudgetCap = (text: string, remainingBudget: number) => { text: string; newBudget: number };

/** Keep hook text that is delivered to the model inside the iteration budget. */
function fitToBudget(
  enforceCap: BudgetCap,
  text: string,
  budget: number,
): { text: string; budget: number } {
  if (budget <= 0 || text.length === 0) return { text: '', budget: Math.max(0, budget) };
  const capped = enforceCap(text, budget);
  if (Buffer.byteLength(capped.text, 'utf8') > budget) return { text: '', budget: 0 };
  return { text: capped.text, budget: capped.newBudget };
}

function rememberPendingContext(
  ctx: Context,
  addition: string,
  budget: number,
  enforceCap: BudgetCap,
): number {
  const piece = ctx.pendingPostToolContext ? `\n\n${addition}` : addition;
  const fitted = fitToBudget(enforceCap, piece, budget);
  if (fitted.text.length > 0) {
    ctx.pendingPostToolContext = ctx.pendingPostToolContext
      ? `${ctx.pendingPostToolContext}${fitted.text}`
      : fitted.text;
  }
  return fitted.budget;
}

export class ToolExecutor extends ToolExecutorCore {
  async executeBatch(
    toolUses: ToolUseBlock[],
    ctx: Context,
    strategy: ToolExecutorStrategy,
  ): Promise<ToolBatchResult> {
    return this.withGovernedExecutionBridge(ctx, () =>
      this.executeBatchInternal(toolUses, ctx, strategy),
    );
  }
  private async executeBatchInternal(
    toolUses: ToolUseBlock[],
    ctx: Context,
    strategy: ToolExecutorStrategy,
  ): Promise<ToolBatchResult> {
    let budget = this.opts.perIterationOutputCapBytes ?? 100_000;

    const runOne = async (use0: ToolUseBlock): Promise<ToolExecutionOutput> => {
      const start = Date.now();
      let use = use0;
      // A preceding call may have connected MCP, changed a plugin, or disabled
      // a tool. Discovery and nested invocation must see the executable registry
      // used by this call, including within a single sequential batch.
      ctx.catalogTools = this.registry.list();
      const tool = this.registry.get(use.name);

      if (!tool) {
        const result = unknownToolResult(use, () => this.registry.list().map((t) => t.name));
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start, settlement: 'unknown_tool' };
      }

      if (!areSubagentsAllowed(ctx) && hasCapability(tool, ToolCapabilities.SUBAGENT_SPAWN)) {
        const result = deniedResult(
          use,
          'Subagents are disabled for this session. This policy is locked after the session starts.',
        );
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start, settlement: 'denied_by_policy' };
      }

      // A run that declared required skills changes nothing until they are
      // loaded. Without a loader registered they could never be, so no gate.
      if (tool.mutating && this.registry.get(REQUIRED_SKILLS_LOADER_TOOL)) {
        const pendingSkills = pendingRequiredSkills(ctx);
        if (pendingSkills.length > 0) {
          const result = deniedResult(use, requiredSkillsDeniedMessage(pendingSkills));
          budget = this.budgetForString(result.content, budget);
          return { result, tool, durationMs: Date.now() - start, settlement: 'denied_by_policy' };
        }
        // A Skill Companion recommendation holds the first file change once;
        // a deliberate retry passes and drops it (see skill-speed-bump.ts).
        const bump = skillSpeedBump(ctx, use);
        if (bump) {
          const result = deniedResult(use, bump);
          budget = this.budgetForString(result.content, budget);
          return { result, tool, durationMs: Date.now() - start, settlement: 'denied_by_policy' };
        }
      }

      const guard = await validateToolInputAndHooks(tool, use, ctx, this.opts);
      if (!guard.ok) {
        const result = guard.errorResult!;
        // A refusal AFTER PreToolUse (later hook deny, tool.validate, Kanban
        // boundary) must still let claim-taking hooks undo their claim.
        if (guard.preToolUseRan) {
          await this.toolSkipped(tool, guard.use, ctx, String(result.content));
        }
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start, settlement: guard.settlement };
      }

      use = guard.use;
      const preToolContext = guard.preToolContext;
      const boundary = guard.boundary ?? { decision: 'allow' as const };
      const gate = await this.authorizeToolUse(tool, use, ctx, preToolContext, boundary, start);
      if (gate.kind === 'done') {
        if (gate.charge !== undefined) budget = this.budgetForString(gate.charge, budget);
        return gate.output;
      }

      const toolCapsForAudit = hasDangerousCapabilityForSubagents(tool)
        ? (tool.capabilities ?? [])
        : [];

      const span = this.opts.tracer?.startSpan(`tool.${tool.name}`, {
        ...spanSessionAttributes(ctx),
        'tool.name': tool.name,
        'tool.mutating': tool.mutating,
        'tool.permission': tool.permission,
        'tool.capabilities':
          toolCapsForAudit.length > 0 ? JSON.stringify(tool.capabilities ?? []) : '[]',
        'tool.has_dangerous_capabilities': toolCapsForAudit.length > 0,
      });
      let postRan = false;
      try {
        const inputPath =
          use.input && typeof use.input === 'object'
            ? (use.input as Record<string, unknown>).path
            : undefined;
        const caps = tool.capabilities ?? [];
        const hasFileCapability = caps.includes('fs.read') || caps.includes('fs.write');
        const absPath =
          hasFileCapability && typeof inputPath === 'string'
            ? path.isAbsolute(inputPath)
              ? inputPath
              : path.resolve(ctx.projectRoot, inputPath)
            : undefined;
        let writeTargetExisted: boolean | undefined;
        if (tool.name === 'write' && caps.includes('fs.write') && absPath) {
          writeTargetExisted = await fs.stat(absPath).then(
            (stat) => stat.isFile(),
            (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? false : undefined),
          );
        }

        const produced = await this.produceToolOutput(tool, use, ctx, budget);
        let producedText = produced.text;
        if (preToolContext?.contextAs === 'inline') {
          producedText = `${producedText}\n\n${preToolContext.text}`;
        }
        let { block: result, bytes } = this.settleToolOutput(tool, use, producedText, budget);
        rememberToolResultFingerprint(
          result,
          preToolContext?.contextAs === 'inline'
            ? fingerprintText(JSON.stringify([produced.fingerprint, preToolContext.text]))
            : produced.fingerprint,
        );
        if (produced.data) rememberProgrammaticOutput(result, produced.data.value);
        budget -= bytes;
        const enforceCap: BudgetCap = (text, room) => this.serializer.enforceCap(text, room);
        await queueDirectoryInstructions(tool, use.input, ctx);
        if (preToolContext?.contextAs === 'separate') {
          budget = rememberPendingContext(ctx, preToolContext.text, budget, enforceCap);
        }
        postRan = true;
        if (this.opts.hookRunner?.has('PostToolUse')) {
          const post = await this.opts.hookRunner.postToolUse(
            tool.name,
            use.input,
            { content: String(result.content), isError: !!result.is_error, ...produced.writePaths },
            ctx,
          );
          if (post.additionalContext) {
            if (post.contextAs === 'separate') {
              budget = rememberPendingContext(ctx, post.additionalContext, budget, enforceCap);
            } else {
              const fitted = fitToBudget(enforceCap, `\n\n${post.additionalContext}`, budget);
              if (fitted.text.length > 0) result = appendToolResultContext(result, fitted.text);
              budget = fitted.budget;
            }
          }
        }
        const outputChars = typeof result.content === 'string' ? result.content.length : 0;
        span?.setAttribute('tool.is_error', !!result.is_error);
        span?.setAttribute('tool.output_bytes', outputChars);
        this.logToolSuccess(ctx, use, tool.name, Date.now() - start, outputChars);

        if (!result.is_error && typeof inputPath === 'string' && absPath) {
          this.emitToolFileEvent(
            tool,
            use,
            ctx,
            inputPath,
            absPath,
            caps,
            writeTargetExisted,
            start,
          );
        }

        return { result, tool, durationMs: Date.now() - start };
      } catch (err) {
        if (!postRan) await this.toolSkipped(tool, use, ctx, toErrorMessage(err));
        if (isWrongStackError(err)) {
          if (err instanceof Error) span?.recordError(err);
          span?.setAttribute('tool.is_error', true);
          this.logToolFailure(ctx, use, tool.name, Date.now() - start, err);
          throw err;
        }
        const msg = toErrorMessage(err);
        const scrubbed = this.opts.secretScrubber.scrub(msg);
        const { category, retryable, detail } = classifyToolError(err);
        this.hintRenderMode(tool.name);
        this.opts.renderer?.writeToolResult(tool.name, scrubbed, true);
        const result = toolErrorResult(use, err, {
          scrubber: (s) => this.opts.secretScrubber.scrub(s),
        });
        if (category === 'validation') result.content += toolInputCorrection(tool);
        // Error results are iteration output too: cap them with the same byte
        // budget the success path enforces, or a single failing tool whose
        // Error message is huge can defeat perIterationOutputCapBytes
        // entirely (budgetForString only charges; it never truncates).
        const cappedError = this.serializer.enforceCap(result.content, budget);
        result.content = cappedError.text;
        budget = cappedError.newBudget;
        if (err instanceof Error) span?.recordError(err);
        span?.setAttribute('tool.is_error', true);
        span?.setAttribute('tool.error_category', category);
        span?.setAttribute('tool.error_retryable', retryable);
        if (detail) span?.setAttribute('tool.error_detail', detail);
        this.logToolFailure(ctx, use, tool.name, Date.now() - start, err);
        return {
          result,
          tool,
          durationMs: Date.now() - start,
          settlement: ctx.signal.aborted ? 'aborted' : 'failed',
        };
      } finally {
        span?.end();
      }
    };

    const safeRun = async (use: ToolUseBlock): Promise<ToolExecutionOutput> => {
      try {
        return await runOne(use);
      } catch (err) {
        const isStructured = isWrongStackError(err);
        const msg = isStructured ? err.describe() : toErrorMessage(err);
        const scrubbed = this.opts.secretScrubber.scrub(msg);
        const tool = this.registry.get(use.name);
        const toolName = tool?.name ?? use.name;
        this.hintRenderMode(toolName);
        this.opts.renderer?.writeToolResult(toolName, scrubbed, true);

        const result = toolErrorResult(use, err, {
          scrubber: (s) => this.opts.secretScrubber.scrub(s),
        });
        if (isStructured) {
          result.content = scrubbed;
        }
        if (tool && classifyToolError(err).category === 'validation') {
          result.content += toolInputCorrection(tool);
        }
        // Same cap discipline as the plain-Error catch above — structured
        // describe() payloads are just as unbounded as Error messages.
        const cappedError = this.serializer.enforceCap(result.content, budget);
        result.content = cappedError.text;
        budget = cappedError.newBudget;
        return {
          result,
          tool,
          durationMs: 0,
          settlement: ctx.signal.aborted ? 'aborted' : 'failed',
        };
      }
    };

    if (strategy === 'sequential') {
      const outputs: ToolExecutionOutput[] = [];
      for (const use of toolUses) {
        if (use) outputs.push(await safeRun(use));
      }
      return { outputs, remainingBudget: budget };
    }

    if (strategy === 'parallel') {
      // "All at once" still may not run two writers of one file together: each
      // reads the file and writes it back whole, so the later write would drop
      // the earlier edit. Calls that share a write target run in order.
      const lanes = new Map<string, Promise<unknown>>();
      const outputs = await mapWithConcurrency(toolUses, this.maxParallelTools, (use) => {
        const keys = this.writeTargetKeys(use, ctx);
        if (keys.length === 0) return safeRun(use);
        const turn = Promise.all(keys.map((key) => lanes.get(key))).then(() => safeRun(use));
        const settled = turn.catch(() => undefined);
        for (const key of keys) lanes.set(key, settled);
        return turn;
      });
      return { outputs, remainingBudget: budget };
    }

    const nonMutating: ToolUseBlock[] = [];
    const mutating: ToolUseBlock[] = [];
    for (const use of toolUses) {
      if (!use) continue;
      const tool = this.registry.get(use.name);
      if (tool?.mutating) mutating.push(use);
      else nonMutating.push(use);
    }
    const firstPass = await mapWithConcurrency(nonMutating, this.maxParallelTools, safeRun);
    const secondPass: ToolExecutionOutput[] = [];
    for (const use of mutating) {
      secondPass.push(await safeRun(use));
    }
    return {
      outputs: [...firstPass, ...secondPass],
      remainingBudget: budget,
    };
  }

  /** The files a mutating call writes, resolved the way the file tools resolve them. */
  private writeTargetKeys(use: ToolUseBlock, ctx: Context): string[] {
    const tool = this.registry.get(use.name);
    if (!tool?.mutating) return [];
    const base = ctx.workingDir ?? ctx.cwd ?? ctx.projectRoot ?? process.cwd();
    return describeWriteTargets(tool, use.input).map((target) => {
      const resolved = path.resolve(base, target);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    });
  }

  private async withGovernedExecutionBridge<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
    const previous = ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY];
    if (typeof previous === 'function') return run();

    const bridge: GovernedToolExecutor = async (toolName, input) => {
      const nestedUse: ToolUseBlock = {
        type: 'tool_use',
        id: `nested-${randomUUID()}`,
        name: toolName,
        input,
      };
      const batch = await this.executeBatchInternal([nestedUse], ctx, 'sequential');
      const output = batch.outputs[0];
      if (!output) {
        return { success: false, error: `tool "${toolName}" produced no result` };
      }
      if (output.result.type === 'tool_confirm_pending') {
        return {
          success: false,
          error: `tool "${toolName}" requires separate confirmation; call it directly`,
        };
      }
      if (output.result.is_error) {
        return { success: false, error: String(output.result.content) };
      }
      return { success: true, result: output.result.content };
    };

    ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY] = bridge;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY];
      else ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY] = previous;
    }
  }

  async executeTool(
    tool: Tool,
    use: ToolUseBlock,
    ctx: Context,
    budget: number,
    preToolContext?: { text: string; contextAs: 'inline' | 'separate' },
  ): Promise<{ block: ToolResultBlock; bytes: number }> {
    ctx.catalogTools = this.registry.list();
    return this.withGovernedExecutionBridge(ctx, async () => {
      let produced: Awaited<ReturnType<ToolExecutorCore['produceToolOutput']>>;
      try {
        produced = await this.produceToolOutput(tool, use, ctx, budget);
      } catch (err) {
        await this.toolSkipped(tool, use, ctx, toErrorMessage(err));
        throw err;
      }
      let text = produced.text;
      if (preToolContext?.contextAs === 'inline') {
        text = `${text}\n\n${preToolContext.text}`;
      }
      const settled = this.settleToolOutput(tool, use, text, budget);
      rememberToolResultFingerprint(
        settled.block,
        preToolContext?.contextAs === 'inline'
          ? fingerprintText(JSON.stringify([produced.fingerprint, preToolContext.text]))
          : produced.fingerprint,
      );
      if (produced.data) rememberProgrammaticOutput(settled.block, produced.data.value);
      let room = budget - settled.bytes;
      const enforceCap: BudgetCap = (value, remaining) =>
        this.serializer.enforceCap(value, remaining);
      await queueDirectoryInstructions(tool, use.input, ctx);
      if (preToolContext?.contextAs === 'separate') {
        room = rememberPendingContext(ctx, preToolContext.text, room, enforceCap);
      }
      // This is the run a confirm prompt approved. It used to skip PostToolUse
      // entirely, so an approved write never released the file lock its
      // PreToolUse claimed and never reached post-write hooks (type-gate...).
      if (this.opts.hookRunner?.has('PostToolUse')) {
        const post = await this.opts.hookRunner.postToolUse(
          tool.name,
          use.input,
          {
            content: String(settled.block.content),
            isError: !!settled.block.is_error,
            ...produced.writePaths,
          },
          ctx,
        );
        if (post.additionalContext) {
          if (post.contextAs === 'separate') {
            rememberPendingContext(ctx, post.additionalContext, room, enforceCap);
          } else {
            const fitted = fitToBudget(enforceCap, `\n\n${post.additionalContext}`, room);
            if (fitted.text.length === 0) return settled;
            return {
              block: appendToolResultContext(settled.block, fitted.text),
              bytes: settled.bytes + Buffer.byteLength(fitted.text, 'utf8'),
            };
          }
        }
      }
      return settled;
    });
  }
}

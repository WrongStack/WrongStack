import type {
  AnyHookOutcome,
  HookEntry,
  HookEvent,
  HookInput,
  HookInvocationContext,
} from '../types/hooks.js';
import type { Logger } from '../types/logger.js';
import { toErrorMessage } from '../utils/error.js';
import { runHttpHookDetailed } from './http-executor.js';
import { type HookRegistry, hookMatcherMatches } from './registry.js';
import {
  type HookExecutionFailure,
  type HookExecutionResult,
  runShellHookDetailed,
} from './shell-executor.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

/** Minimal run-state the runner reads. `Context` structurally satisfies it. */
export interface HookRunEnv {
  cwd: string;
  signal?: AbortSignal | undefined;
}

export interface HookRunnerOptions {
  registry: HookRegistry;
  logger?: Logger | undefined;
  /**
   * When false, ordinary hooks are skipped across every transport;
   * `policy: true` enforcement hooks still run.
   */
  allowNonPolicy?: boolean | undefined;
  /** @deprecated Use `allowNonPolicy`; retained for API compatibility. */
  allowShell?: boolean | undefined;
  /** Resolves the active session id for the `HookInput` payload. */
  sessionId?: (() => string) | undefined;
}

export interface PreToolUseResult {
  block?: boolean | undefined;
  reason?: string | undefined;
  /** Present only when a hook replaced the tool input. */
  input?: Record<string, unknown>;
}

type NormalizedPreToolOutcome =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'mutate'; input: Record<string, unknown>; reason?: string | undefined };

function normalizePreToolOutcome(outcome: AnyHookOutcome): NormalizedPreToolOutcome {
  if ('action' in outcome) return outcome;
  if (outcome.decision === 'block') {
    return { action: 'deny', reason: outcome.reason?.trim() || 'blocked by PreToolUse hook' };
  }
  if (outcome.modifiedInput && typeof outcome.modifiedInput === 'object') {
    return {
      action: 'mutate',
      input: outcome.modifiedInput,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }
  return { action: 'allow' };
}

function malformedOutcome(outcome: AnyHookOutcome): string | undefined {
  if (!('action' in outcome)) return undefined;
  if (outcome.action === 'allow') return undefined;
  if (outcome.action === 'deny') {
    return typeof outcome.reason === 'string' && outcome.reason.trim()
      ? undefined
      : 'deny outcome requires a non-empty reason';
  }
  if (outcome.action === 'mutate') {
    return outcome.input && typeof outcome.input === 'object' && !Array.isArray(outcome.input)
      ? undefined
      : 'mutate outcome requires an object input';
  }
  return `unknown hook action: ${String((outcome as { action?: unknown }).action)}`;
}

export interface PromptResult {
  block?: boolean | undefined;
  reason?: string | undefined;
  additionalContext?: string | undefined;
}

/**
 * Drives the registered hooks at each lifecycle phase. Pure orchestration —
 * the executor / pipeline / agent extension call the matching method and act on
 * the returned decision. Fail-open hooks are skipped on failure; fail-closed
 * policy hooks turn failures into explicit denials without prompting the user.
 */
export class HookRunner {
  private readonly registry: HookRegistry;

  constructor(private readonly opts: HookRunnerOptions) {
    this.registry = opts.registry;
  }

  /** Cheap guard so callers can skip building payloads when nothing listens. */
  has(event: HookEvent): boolean {
    return this.registry.has(event);
  }

  async preToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    env: HookRunEnv,
  ): Promise<PreToolUseResult> {
    const entries = this.matching('PreToolUse', toolName);
    if (entries.length === 0) return {};
    let current = toolInput;
    let mutated = false;
    const mutators = entries.filter((entry) => entry.stage === 'mutate');
    const validators = entries.filter((entry) => entry.stage === 'validate');

    // Mutators compose in registration order. A mutator may still deny when it
    // cannot produce a safe replacement (for example secret redaction).
    for (const entry of mutators) {
      const payload: HookInput = {
        event: 'PreToolUse',
        toolName,
        toolInput: current,
        ...this.base(env),
      };
      const outcome = await this.invoke(entry, payload, env);
      if (!outcome) continue;
      const normalized = normalizePreToolOutcome(outcome);
      if (normalized.action === 'deny') {
        return { block: true, reason: normalized.reason };
      }
      if (normalized.action === 'mutate') {
        current = normalized.input;
        mutated = true;
      }
    }

    // Validators all inspect the final mutated input. Rewriting from this phase
    // is rejected so no later hook can invalidate an earlier security verdict.
    for (const entry of validators) {
      const payload: HookInput = {
        event: 'PreToolUse',
        toolName,
        toolInput: current,
        ...this.base(env),
      };
      const outcome = await this.invoke(entry, payload, env);
      if (!outcome) continue;
      const normalized = normalizePreToolOutcome(outcome);
      if (normalized.action === 'deny') {
        return { block: true, reason: normalized.reason };
      }
      if (normalized.action === 'mutate') {
        const reason = `PreToolUse validator "${entry.name}" attempted to mutate tool arguments`;
        this.opts.logger?.warn?.(reason);
        if (entry.failurePolicy === 'closed') return { block: true, reason };
      }
    }
    return mutated ? { input: current } : {};
  }

  async postToolUse(
    toolName: string,
    toolInput: unknown,
    result: { content: string; isError: boolean },
    env: HookRunEnv,
  ): Promise<{ additionalContext?: string | undefined; contextAs?: 'inline' | 'separate' }> {
    const payload: HookInput = {
      event: 'PostToolUse',
      toolName,
      toolInput,
      toolResult: result,
      ...this.base(env),
    };
    const entries = this.matching('PostToolUse', toolName);
    if (entries.length === 0) return {};

    // Background hooks run fire-and-forget — the tool executor returns
    // immediately without collecting their additionalContext. Use this for
    // purely advisory hooks (format-on-save, code-metrics, dead-code scans,
    // etc.) where same-turn feedback is not required.
    const foreground: HookEntry[] = [];
    for (const entry of entries) {
      if (entry.background) {
        // Fire-and-forget: invoke without await, swallow errors.
        this.invoke(entry, payload, env).catch(() => {});
      } else {
        foreground.push(entry);
      }
    }

    // No foreground hooks — return immediately, don't wait for background.
    if (foreground.length === 0) return {};

    const results = await Promise.allSettled(
      foreground.map((entry) => this.invoke(entry, payload, env)),
    );
    const parts: string[] = [];
    let separate = false;
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value?.additionalContext) continue;
      parts.push(result.value.additionalContext);
      if (result.value.contextAs === 'separate') separate = true;
    }
    return parts.length
      ? { additionalContext: parts.join('\n'), contextAs: separate ? 'separate' : 'inline' }
      : {};
  }

  async userPromptSubmit(prompt: string, env: HookRunEnv): Promise<PromptResult> {
    const entries = this.matching('UserPromptSubmit', undefined);
    if (entries.length === 0) return {};
    const payload: HookInput = { event: 'UserPromptSubmit', prompt, ...this.base(env) };
    const parts: string[] = [];
    for (const entry of entries) {
      const outcome = await this.invoke(entry, payload, env);
      if (!outcome) continue;
      const denied = 'action' in outcome ? outcome.action === 'deny' : outcome.decision === 'block';
      if (denied) {
        const reason = 'reason' in outcome ? outcome.reason : undefined;
        return { block: true, reason: reason ?? 'Blocked by UserPromptSubmit hook' };
      }
      if (outcome.additionalContext) parts.push(outcome.additionalContext);
    }
    return parts.length ? { additionalContext: parts.join('\n') } : {};
  }

  async sessionStart(env: HookRunEnv): Promise<{ additionalContext?: string | undefined }> {
    const payload: HookInput = { event: 'SessionStart', ...this.base(env) };
    return {
      additionalContext: await this.collectContext('SessionStart', undefined, payload, env),
    };
  }

  async stop(env: HookRunEnv): Promise<void> {
    const payload: HookInput = { event: 'Stop', ...this.base(env) };
    await this.collectContext('Stop', undefined, payload, env);
  }

  // ── internals ──────────────────────────────────────────────────────

  private base(env: HookRunEnv): { cwd: string; sessionId?: string | undefined } {
    const sessionId = this.opts.sessionId?.();
    return sessionId ? { cwd: env.cwd, sessionId } : { cwd: env.cwd };
  }

  private matching(event: HookEvent, toolName: string | undefined): readonly HookEntry[] {
    return this.registry.list(event).filter((e) => hookMatcherMatches(e.matcher, toolName));
  }

  private async invoke(
    entry: HookEntry,
    payload: HookInput,
    env: HookRunEnv,
  ): Promise<AnyHookOutcome | null> {
    const allowNonPolicy = this.opts.allowNonPolicy ?? this.opts.allowShell ?? true;
    if (!allowNonPolicy && !entry.policy) return null;

    let result: HookExecutionResult;
    if (entry.kind === 'inprocess') {
      result = await this.invokeInProcess(entry, payload, env);
    } else {
      result =
        entry.kind === 'shell'
          ? await runShellHookDetailed(
              { command: entry.command, timeoutMs: entry.timeoutMs },
              payload,
              this.opts.logger,
              { signal: env.signal },
            )
          : await runHttpHookDetailed(
              { url: entry.url, headers: entry.headers, timeoutMs: entry.timeoutMs },
              payload,
              this.opts.logger,
              { signal: env.signal },
            );
    }

    if (!result.failure && result.outcome) {
      const malformed = malformedOutcome(result.outcome);
      if (malformed) {
        result = {
          outcome: null,
          failure: { kind: 'invalid_output', message: malformed },
        };
      }
    }
    if (!result.failure) return result.outcome;
    this.opts.logger?.warn?.(
      `${payload.event} hook "${entry.name}" failed (${result.failure.kind}): ${result.failure.message}`,
    );
    return this.failureOutcome(entry, payload, result.failure);
  }

  private async invokeInProcess(
    entry: Extract<HookEntry, { kind: 'inprocess' }>,
    payload: HookInput,
    env: HookRunEnv,
  ): Promise<HookExecutionResult> {
    const timeoutMs = Math.max(1, Math.min(entry.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => controller.abort(env.signal?.reason);
    if (env.signal?.aborted) {
      return { outcome: null, failure: { kind: 'aborted', message: 'hook invocation aborted' } };
    }
    env.signal?.addEventListener('abort', onParentAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('hook timeout'));
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    const runtime: HookInvocationContext = {
      signal: controller.signal,
      deadlineAt: Date.now() + timeoutMs,
    };

    try {
      const invocation = Promise.resolve().then(() => entry.hook(payload, runtime));
      const outcome = await Promise.race([invocation, timeout]);
      if (outcome === undefined) return { outcome: null };
      if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
        return {
          outcome: null,
          failure: {
            kind: 'invalid_output',
            message: 'in-process hook returned a non-object outcome',
          },
        };
      }
      return { outcome };
    } catch (err) {
      const aborted = env.signal?.aborted === true;
      return {
        outcome: null,
        failure: {
          kind: timedOut ? 'timeout' : aborted ? 'aborted' : 'error',
          message: toErrorMessage(err),
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
      env.signal?.removeEventListener('abort', onParentAbort);
    }
  }

  private failureOutcome(
    entry: HookEntry,
    payload: HookInput,
    failure: HookExecutionFailure,
  ): AnyHookOutcome | null {
    if (entry.failurePolicy !== 'closed') return null;
    const reason =
      `${payload.event} policy hook "${entry.name}" failed (${failure.kind}); ` +
      'the action was denied by fail-closed policy. This is not an approval request.';
    if (payload.event === 'PreToolUse') return { action: 'deny', reason };
    if (payload.event === 'UserPromptSubmit') return { decision: 'block', reason };
    return null;
  }

  private async collectContext(
    event: HookEvent,
    toolName: string | undefined,
    payload: HookInput,
    env: HookRunEnv,
  ): Promise<string | undefined> {
    const entries = this.matching(event, toolName);
    if (entries.length === 0) return undefined;
    // Run all matching hooks in parallel — none mutate state or block;
    // each only returns additionalContext which is independently useful.
    const results = await Promise.allSettled(
      entries.map((entry) => this.invoke(entry, payload, env)),
    );
    const parts: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value?.additionalContext) {
        parts.push(result.value.additionalContext);
      }
    }
    return parts.length ? parts.join('\n') : undefined;
  }
}

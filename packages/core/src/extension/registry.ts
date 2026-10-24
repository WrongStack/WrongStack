import { expectDefined } from '../utils/expect-defined.js';
/**
 * ExtensionRegistry — manages AgentExtension registrations.
 *
 * Extensions are called in registration order at each lifecycle phase.
 * Each extension hook failure is caught and logged independently so
 * one bad extension can't take down the agent.
 */

import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import { ERROR_CODES, WrongStackError } from '@wrongstack/contracts/types/errors';
import type {
  AfterIterationHook,
  AfterRunHook,
  AfterToolExecutionHook,
  AgentExtension,
  BeforeIterationHook,
  BeforeRunHook,
  BeforeToolExecutionHook,
  BeforeTurnEndHook,
  ExtensionRegistryPort,
  OnErrorHook,
  ProviderRunnerFn,
} from '@wrongstack/contracts/types/extension-points';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { SystemPromptContributor } from '@wrongstack/contracts/types/system-prompt-contributor';

interface ExtensionRegistration {
  extension: AgentExtension;
  order: number;
  previous?: ExtensionRegistration;
  removed?: boolean;
}
export class ExtensionRegistry implements ExtensionRegistryPort {
  private readonly extensions: AgentExtension[] = [];
  private readonly registrations = new Map<string, ExtensionRegistration>();
  private nextRegistrationOrder = 0;
  private readonly promptContributors: SystemPromptContributor[] = [];
  private log: Logger | undefined;

  setLogger(log: Logger): void {
    this.log = log;
  }

  /**
   * Register a system prompt contributor. Returns an unregister function.
   * Contributors are called on every system prompt build in registration
   * order. Their output blocks are inserted after the core environment
   * block, before the mode and plan blocks.
   */
  registerSystemPromptContributor(c: SystemPromptContributor): () => void {
    // A distinct carrier keeps equal contributor functions independently owned.
    const registered: SystemPromptContributor = Object.assign(
      (ctx: Parameters<SystemPromptContributor>[0]) => c(ctx),
      c,
    );
    this.promptContributors.push(registered);
    return () => {
      const idx = this.promptContributors.indexOf(registered);
      if (idx >= 0) this.promptContributors.splice(idx, 1);
    };
  }

  /**
   * Build all registered system prompt contributions.
   * Failures are caught and logged — one bad contributor doesn't
   * break the prompt assembly.
   */
  async buildSystemPromptContributions(
    ctx: Parameters<SystemPromptContributor>[0],
  ): Promise<TextBlock[]> {
    const blocks: TextBlock[] = [];
    // Snapshot before iterating so mid-iteration registration doesn't cause
    // skipped or duplicate contributor invocations during this phase.
    const snapshot = [...this.promptContributors];
    for (const c of snapshot) {
      try {
        const contributed = await c(ctx);
        blocks.push(...contributed);
      } catch (err) {
        this.log?.error('SystemPromptContributor failed', err);
      }
    }
    return blocks;
  }

  /**
   * Returns the live array of contributors (readonly snapshot for
   * passing to DefaultSystemPromptBuilder at build time).
   */
  listSystemPromptContributors(): readonly SystemPromptContributor[] {
    return this.promptContributors;
  }

  /**
   * Register an extension. Duplicate names are rejected.
   * Returns an unregister function.
   */
  register(ext: AgentExtension): () => void {
    if (this.extensions.some((e) => e.name === ext.name)) {
      throw new WrongStackError({
        message: `Extension "${ext.name}" already registered`,
        code: ERROR_CODES.REGISTRY_DUPLICATE,
        subsystem: 'container',
        context: { extension: ext.name },
      });
    }
    const registration: ExtensionRegistration = {
      extension: ext,
      order: this.nextRegistrationOrder++,
    };
    this.registrations.set(ext.name, registration);
    this.extensions.push(ext);
    return () => {
      if (registration.removed) return;
      registration.removed = true;
      if (this.registrations.get(ext.name) !== registration) return;
      const index = this.extensions.indexOf(ext);
      if (index >= 0) this.extensions.splice(index, 1);
      let previous = registration.previous;
      while (previous?.removed) previous = previous.previous;
      if (previous) {
        this.registrations.set(ext.name, previous);
        const position = this.extensions.findIndex(
          (entry) => (this.registrations.get(entry.name)?.order ?? Infinity) > previous.order,
        );
        this.extensions.splice(
          position < 0 ? this.extensions.length : position,
          0,
          previous.extension,
        );
      } else {
        this.registrations.delete(ext.name);
      }
    };
  }

  /**
   * Register an extension, silently replacing any previous registration
   * with the same name. Use this when overriding a default extension.
   */
  registerOrReplace(ext: AgentExtension): () => void {
    const idx = this.extensions.findIndex((e) => e.name === ext.name);
    if (idx >= 0) this.extensions.splice(idx, 1);
    return this.register(ext);
  }

  /** Temporarily replace an extension; cleanup restores only surviving previous registrations. */
  registerOrReplaceScoped(ext: AgentExtension): () => void {
    const previous = this.registrations.get(ext.name);
    const dispose = this.registerOrReplace(ext);
    const registration = this.registrations.get(ext.name)!;
    if (previous) registration.previous = previous;
    return dispose;
  }

  /**
   * Unregister an extension by name. Returns true if found.
   */
  unregister(name: string): boolean {
    const idx = this.extensions.findIndex((e) => e.name === name);
    if (idx === -1) return false;
    this.extensions.splice(idx, 1);
    this.registrations.delete(name);
    return true;
  }

  /**
   * List registered extension names in order.
   */
  list(): readonly string[] {
    return this.extensions.map((e) => e.name);
  }

  /**
   * Check if an extension with the given name is registered.
   */
  has(name: string): boolean {
    return this.extensions.some((e) => e.name === name);
  }

  /**
   * Remove all registered extensions and contributors.
   */
  clear(): void {
    this.extensions.length = 0;
    this.registrations.clear();
    this.promptContributors.length = 0;
  }

  // ── Hook runners ─────────────────────────────────────────────────

  async runBeforeRun(...args: Parameters<BeforeRunHook>): Promise<void> {
    const snapshot = [...this.extensions];
    for (const ext of snapshot) {
      if (!ext.beforeRun) continue;
      try {
        await ext.beforeRun(...args);
      } catch (err) {
        this.log?.error(`Extension "${ext.name}" beforeRun hook failed`, err);
      }
    }
  }

  async runAfterRun(...args: Parameters<AfterRunHook>): Promise<void> {
    const snapshot = [...this.extensions];
    for (const ext of snapshot) {
      if (!ext.afterRun) continue;
      try {
        await ext.afterRun(...args);
      } catch (err) {
        this.log?.error(`Extension "${ext.name}" afterRun hook failed`, err);
      }
    }
  }

  async runBeforeIteration(...args: Parameters<BeforeIterationHook>): Promise<void> {
    const snapshot = [...this.extensions];
    for (const ext of snapshot) {
      if (!ext.beforeIteration) continue;
      try {
        await ext.beforeIteration(...args);
      } catch (err) {
        this.log?.error(`Extension "${ext.name}" beforeIteration hook failed`, err);
      }
    }
  }

  async runAfterIteration(...args: Parameters<AfterIterationHook>): Promise<void> {
    const snapshot = [...this.extensions];
    for (const ext of snapshot) {
      if (!ext.afterIteration) continue;
      try {
        await ext.afterIteration(...args);
      } catch (err) {
        this.log?.error(`Extension "${ext.name}" afterIteration hook failed`, err);
      }
    }
  }

  /**
   * Ask beforeTurnEnd hooks, in order, whether the turn may end. The first
   * non-empty steering message wins and holds the turn; a failing hook is
   * logged and treated as "may end", never as a reason to hold.
   */
  async runBeforeTurnEnd(...args: Parameters<BeforeTurnEndHook>): Promise<string | undefined> {
    const snapshot = [...this.extensions];
    for (const ext of snapshot) {
      if (!ext.beforeTurnEnd) continue;
      try {
        const steer = await ext.beforeTurnEnd(...args);
        if (steer?.trim()) return steer;
      } catch (err) {
        this.log?.error(`Extension "${ext.name}" beforeTurnEnd hook failed`, err);
      }
    }
    return undefined;
  }

  /**
   * Run onError hooks in order. The first hook that returns a non-void
   * result wins; subsequent hooks are skipped.
   */
  async runOnError(
    ...args: Parameters<OnErrorHook>
  ): Promise<
    | { action: 'retry'; model?: string | undefined }
    | { action: 'fail' }
    | { action: 'continue' }
    | void
  > {
    const snapshot = [...this.extensions];
    for (const ext of snapshot) {
      if (!ext.onError) continue;
      try {
        const result = await ext.onError(...args);
        if (result) return result;
      } catch (err) {
        this.log?.error(`Extension "${ext.name}" onError hook failed`, err);
      }
    }
  }

  /**
   * Build a composed provider runner. Extensions with `wrapProviderRunner`
   * form a middleware-style chain: the innermost extension wraps the
   * default runner, each subsequent wrapper wraps the previous.
   *
   * Utility calls may exclude agent-loop-only middleware (notably
   * `fallback-model`) while retaining request-safety wrappers such as the
   * prompt firewall. One-shot orchestration owns its provider and fallback
   * route, so an agent-loop fallback wrapper cannot safely run against it.
   */
  wrapProviderRunner(
    inner: ProviderRunnerFn,
    options?: { exclude?: readonly string[] | undefined },
  ): ProviderRunnerFn {
    const excluded = new Set(options?.exclude);
    const wrappers = this.extensions
      .filter((e) => e.wrapProviderRunner && !excluded.has(e.name))
      .map((e) => ({ name: e.name, wrap: expectDefined(e.wrapProviderRunner) }));

    if (wrappers.length === 0) return inner;

    // Build chain from innermost to outermost
    let composed: ProviderRunnerFn = inner;
    for (let i = wrappers.length - 1; i >= 0; i--) {
      const wrapper = wrappers[i];
      if (!wrapper) continue;
      const next = composed;
      composed = async (ctx, req) => {
        try {
          return await wrapper.wrap(ctx, req, next);
        } catch (err) {
          // A run torn down mid-request (session end, Ctrl+C) surfaces here as
          // the abort it is; logging it at error level printed a failure at the
          // end of every headless run that delegated work.
          if (ctx?.signal?.aborted) {
            this.log?.debug(`Extension "${wrapper.name}" wrapProviderRunner: run aborted`, err);
          } else {
            this.log?.error(`Extension "${wrapper.name}" wrapProviderRunner failed`, err);
          }
          throw err;
        }
      };
    }
    return composed;
  }

  async runBeforeToolExecution(
    ...args: Parameters<BeforeToolExecutionHook>
  ): Promise<Parameters<BeforeToolExecutionHook>[1]> {
    let toolUses = args[1];
    const snapshot = [...this.extensions];
    for (const ext of snapshot) {
      if (!ext.beforeToolExecution) continue;
      try {
        toolUses = await ext.beforeToolExecution(args[0], toolUses);
      } catch (err) {
        this.log?.error(`Extension "${ext.name}" beforeToolExecution hook failed`, err);
      }
    }
    return toolUses;
  }

  async runAfterToolExecution(...args: Parameters<AfterToolExecutionHook>): Promise<void> {
    const snapshot = [...this.extensions];
    for (const ext of snapshot) {
      if (!ext.afterToolExecution) continue;
      try {
        await ext.afterToolExecution(...args);
      } catch (err) {
        this.log?.error(`Extension "${ext.name}" afterToolExecution hook failed`, err);
      }
    }
  }
}

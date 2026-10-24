/**
 * Directory-scoped permission policy wrapper.
 *
 * Adds per-directory rules on top of an inner `PermissionPolicy`. The
 * inner policy is the existing `DefaultPermissionPolicy` (or any other
 * `PermissionPolicy` implementation); this wrapper consults
 * `.wrongstack/directory-rules.json` BEFORE delegating to the inner
 * policy. When a rule applies to the tool call's target path, the
 * wrapper's decision is final; otherwise it is a transparent
 * pass-through.
 *
 * Rule precedence (most-restrictive wins):
 *   1. `allowOnlyTools` — when declared, deny tools not in the list.
 *      An empty list denies every tool. This is the strictest form: it
 *      cannot be widened by an inner-policy allow.
 *   2. `denyTools` — deny if the tool name matches. This is also
 *      strict: a directory-level ban overrides an inner-policy allow.
 *   3. `denyProviders` — deny if the active `ctx.provider.id` matches.
 *      Provider bans are enforced at tool-call time (the tool itself
 *      is not a provider, but the active session provider is).
 *   4. No match — pass through to the inner policy.
 *
 * "Most-specific match wins" among multiple matching rules: the rule
 * with the longest non-wildcard path component (i.e. the most literal
 * prefix) wins. Ties fall back to first-declared order.
 *
 * Path resolution: target paths are extracted from explicit filesystem
 * input keys (for example `path`, `file`, `directory`, `outputPath`, and
 * `worktreePath`) and resolved against `ctx.workingDir` (NOT `projectRoot`)
 * so a sub-agent that has changed directory still gets the right rule.
 * The resolved absolute path is then normalized to forward slashes.
 *
 * When none of those filesystem keys is present, the wrapper passes through;
 * URLs, shell command strings, and logical resource names are not interpreted
 * as filesystem paths by this directory-scoped policy.
 *
 * Session-level toggle: `ctx.meta['directoryRules'] = false` disables
 * the wrapper entirely (returns inner policy result unchanged) so
 * callers can flip the layer off without re-instantiating the policy.
 */

import type { AgentContext } from '@wrongstack/contracts/types/context';
import type {
  DirectoryPolicy,
  DirectoryRule,
  PermissionDecision,
  PermissionPolicy,
  PermissionTrace,
  PermissionTraceStep,
} from '@wrongstack/contracts/types/permission';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { providerIdentities } from '../utils/provider-catalog-binding.js';
import {
  clonePolicy,
  deny,
  isToolInList,
  matchTargetRules,
  resolveGlobSelectors,
  resolveTargetPaths,
} from './directory-permission-matching.js';
import { refusalUnderYolo } from './permission-helpers.js';
import { permissionRuleRef, type UnnumberedPermissionRule } from './permission-rules.js';
import { type DestructiveKind, normalizeYoloConfirmKinds } from './yolo-risk.js';

export { matchRule, resolveTargetPath } from './directory-permission-matching.js';

export interface DirectoryPermissionPolicyOptions {
  /**
   * The directory policy to enforce. Pass an empty policy
   * (`{ schemaVersion: 1, rules: [] }`) to disable enforcement while
   * keeping the wrapper installed — useful as a default-allow stance.
   */
  policy: DirectoryPolicy;
}

export class DirectoryPermissionPolicy implements PermissionPolicy {
  private readonly inner: PermissionPolicy;
  private policy: DirectoryPolicy;

  constructor(inner: PermissionPolicy, options: DirectoryPermissionPolicyOptions) {
    this.inner = inner;
    this.policy = clonePolicy(options.policy);
  }

  /** Replace the in-memory directory policy. Does NOT reload from disk. */
  setPolicy(policy: DirectoryPolicy): void {
    this.policy = clonePolicy(policy);
  }

  /** Read-only access to the current directory policy for diagnostics. */
  getPolicy(): DirectoryPolicy {
    return clonePolicy(this.policy);
  }

  async evaluate(tool: Tool, input: unknown, ctx: AgentContext): Promise<PermissionDecision> {
    // Session-level disable toggle: pass through when the layer is off.
    if (ctx.meta['directoryRules'] === false) {
      return this.inner.evaluate(tool, input, ctx);
    }

    // Empty policy = no rules → pass through.
    if (this.policy.rules.length === 0) {
      return this.inner.evaluate(tool, input, ctx);
    }

    // Evaluate every explicit target. Multi-file tools must not bypass a
    // protected directory by placing an unrestricted path first.
    const targetPaths = resolveTargetPaths(input, ctx);
    if (targetPaths.length === 0) {
      return this.inner.evaluate(tool, input, ctx);
    }
    const globSelectors = resolveGlobSelectors(input, ctx);

    for (const rule of targetPaths.flatMap((targetPath) =>
      matchTargetRules(this.policy, targetPath, globSelectors),
    )) {
      // Provider ban — checked against ctx.provider.id. Independent of
      // the tool name; a model under a denied provider is banned for
      // any tool call targeting this directory.
      if (
        rule.denyProviders &&
        rule.denyProviders.length > 0 &&
        ctx.provider?.id &&
        deniesProvider(rule.denyProviders, ctx.provider)
      ) {
        return this.refuse(
          tool,
          input,
          ctx,
          deny(
            `provider "${ctx.provider.id}" is denied in this directory`,
            rule,
            'denyProviders',
            tool.name,
          ),
        );
      }

      // allowOnlyTools — most restrictive form. If the tool is not in
      // the declared allow list, deny. An empty list intentionally denies
      // every tool. Computed before denyTools so the stricter rule wins.
      if (rule.allowOnlyTools != null && !isToolInList(tool.name, rule.allowOnlyTools)) {
        return this.refuse(
          tool,
          input,
          ctx,
          deny(
            `tool "${tool.name}" is not in the allowOnlyTools list for this directory`,
            rule,
            'allowOnlyTools',
            tool.name,
          ),
        );
      }

      // denyTools — ban specific tool names (or namespace patterns).
      if (rule.denyTools && isToolInList(tool.name, rule.denyTools)) {
        return this.refuse(
          tool,
          input,
          ctx,
          deny(`tool "${tool.name}" is denied in this directory`, rule, 'denyTools', tool.name),
        );
      }
    }

    // No target constraint denied this call → pass through to the inner policy.
    return this.inner.evaluate(tool, input, ctx);
  }

  /**
   * A directory rule is a refusal the user wrote, so it follows the same rule
   * as the inner policy's (`refusalUnderYolo`): off and YOLO+ refuse, YOLO
   * asks. Before turning it into a question, the inner policy's verdict is
   * read through `explain()` — side-effect free, unlike `evaluate()`, which
   * can prompt — so a "yes" here never runs a call the inner policy refuses
   * outright (a `permission: 'deny'` tool, an invalid trust file). An inner
   * policy that cannot say keeps the refusal.
   */
  private async refuse(
    tool: Tool,
    input: unknown,
    ctx: AgentContext,
    refusal: PermissionDecision,
  ): Promise<PermissionDecision> {
    const mode = this.inner.yoloModeFor?.(ctx);
    if (!mode) return refusal;
    const asked = refusalUnderYolo(refusal, mode);
    if (asked === refusal) return refusal;
    if (!this.inner.explain) return refusal;
    const inner = await this.inner.explain(tool, input, ctx);
    return inner.decision.permission === 'deny' ? inner.decision : asked;
  }

  yoloModeFor(ctx?: Pick<AgentContext, 'meta'> | undefined): { yolo: boolean; yoloPlus: boolean } {
    return this.inner.yoloModeFor?.(ctx) ?? { yolo: false, yoloPlus: false };
  }

  getYolo(): boolean {
    return this.inner.getYolo?.() ?? false;
  }

  setYolo(enabled: boolean): void {
    this.inner.setYolo?.(enabled);
  }

  getYoloPlus(): boolean {
    return this.inner.getYoloPlus?.() ?? false;
  }

  setYoloPlus(enabled: boolean): void {
    this.inner.setYoloPlus?.(enabled);
  }

  getYoloDestructive(): boolean {
    return this.inner.getYoloDestructive?.() ?? false;
  }

  setYoloDestructive(enabled: boolean): void {
    this.inner.setYoloDestructive?.(enabled);
  }

  getYoloConfirmKinds(): ReadonlySet<DestructiveKind> {
    return this.inner.getYoloConfirmKinds?.() ?? normalizeYoloConfirmKinds(undefined);
  }

  setYoloConfirmKinds(kinds: Iterable<DestructiveKind>): void {
    this.inner.setYoloConfirmKinds?.(kinds);
  }

  getConfirmDestructive(): boolean {
    return this.inner.getConfirmDestructive?.() ?? false;
  }

  setConfirmDestructive(enabled: boolean): void {
    this.inner.setConfirmDestructive?.(enabled);
  }

  setPromptDelegate(
    delegate:
      | ((
          tool: Tool,
          input: unknown,
          suggestedPattern: string,
        ) => Promise<
          'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny'
        >)
      | undefined,
  ): void {
    this.inner.setPromptDelegate?.(delegate);
  }

  async trust(rule: { tool: string; pattern: string }): Promise<void> {
    return this.inner.trust(rule);
  }

  async deny(rule: { tool: string; pattern: string }): Promise<void> {
    return this.inner.deny(rule);
  }

  denyOnce(rule: { tool: string; pattern: string }): void {
    this.inner.denyOnce(rule);
  }

  allowOnce(rule: { tool: string; pattern: string }): void {
    this.inner.allowOnce(rule);
  }

  async reload(): Promise<void> {
    // Directory policy is in-memory only; reload delegates to the
    // inner policy. Hosts that want hot-reload should re-construct
    // the wrapper with a fresh policy.
    await this.inner.reload();
  }

  /** Its own rules first (they are checked first), then the inner policy's. */
  async listRules(ctx?: AgentContext | undefined): Promise<UnnumberedPermissionRule[]> {
    const inner = (await this.inner.listRules?.(ctx)) ?? [];
    if (ctx?.meta['directoryRules'] === false) return inner;
    const own: UnnumberedPermissionRule[] = [];
    for (const [index, rule] of this.policy.rules.entries()) {
      const base = {
        ref: permissionRuleRef.directory(index),
        source: 'directory-rules' as const,
        effect: 'deny' as const,
        ...(rule.description ? { note: rule.description } : {}),
      };
      if (rule.denyProviders?.length) {
        own.push({
          ...base,
          step: 'denyProviders',
          action: '*',
          resource: `${rule.directory} (provider ${rule.denyProviders.join(', ')})`,
        });
      }
      if (rule.allowOnlyTools != null) {
        own.push({
          ...base,
          step: 'allowOnlyTools',
          action: rule.allowOnlyTools.length
            ? `every tool except ${rule.allowOnlyTools.join(', ')}`
            : '*',
          resource: rule.directory,
        });
      }
      if (rule.denyTools?.length) {
        own.push({
          ...base,
          step: 'denyTools',
          action: rule.denyTools.join(', '),
          resource: rule.directory,
        });
      }
    }
    return [...own, ...inner];
  }

  async explain(tool: Tool, input: unknown, ctx: AgentContext): Promise<PermissionTrace> {
    const steps: PermissionTraceStep[] = [];
    let winnerIndex = -1;
    // A pass-through is only half an answer: the inner policy decided, and its
    // steps are the "why". Returning its decision alone named "directory rules
    // pass through" the winner of every call no rule touched, and hid the YOLO,
    // trust or default step that actually decided it.
    const delegate = async (subject: string | null | undefined): Promise<PermissionTrace> => {
      if (!this.inner.explain) {
        const decision = await this.inner.evaluate(tool, input, ctx);
        return { toolName: tool.name, subject: subject ?? null, steps, winnerIndex, decision };
      }
      const inner = await this.inner.explain(tool, input, ctx);
      return {
        toolName: tool.name,
        subject: inner.subject ?? subject ?? null,
        steps: [...steps, ...inner.steps],
        winnerIndex: inner.winnerIndex < 0 ? winnerIndex : steps.length + inner.winnerIndex,
        decision: inner.decision,
      };
    };

    const add = (
      rule: string,
      matched: boolean,
      decision: 'auto' | 'deny' | 'confirm',
      source: string,
      detail: string,
      ref?: string | undefined,
    ): void => {
      steps.push({
        rule,
        matched,
        decision,
        source,
        detail,
        ...(ref !== undefined ? { ref } : {}),
      });
    };
    const refOf = (rule: DirectoryRule) =>
      permissionRuleRef.directory(this.policy.rules.indexOf(rule));

    if (ctx.meta['directoryRules'] === false) {
      add(
        'directory rules disabled',
        true,
        'auto',
        'default',
        'ctx.meta.directoryRules === false — wrapper is a pass-through',
      );
      winnerIndex = steps.length - 1;
      return delegate(null);
    }
    add(
      'directory rules enabled',
      false,
      'auto',
      'default',
      'wrapper consults directory policy before inner policy',
    );

    if (this.policy.rules.length === 0) {
      add('empty directory policy', true, 'auto', 'default', 'no directory rules configured');
      winnerIndex = steps.length - 1;
      return delegate(null);
    }
    add(
      'empty directory policy',
      false,
      'auto',
      'default',
      `${this.policy.rules.length} rule(s) configured`,
    );

    const targetPaths = resolveTargetPaths(input, ctx);
    if (targetPaths.length === 0) {
      add(
        'no target path',
        true,
        'auto',
        'default',
        'tool input has no path subject — wrapper cannot match any rule',
      );
      winnerIndex = steps.length - 1;
      return delegate(null);
    }
    const globSelectors = resolveGlobSelectors(input, ctx);

    const targetRules = targetPaths.flatMap((targetPath) => {
      const rules: Array<DirectoryRule | undefined> = matchTargetRules(
        this.policy,
        targetPath,
        globSelectors,
      );
      if (rules.length === 0) rules.push(undefined);
      return rules.map((rule) => ({ targetPath, rule }));
    });
    for (const { targetPath, rule } of targetRules) {
      add('target path', false, 'auto', 'default', `resolved "${targetPath}"`);
      if (!rule) {
        add('directory rule match', false, 'auto', 'default', `no rule matched "${targetPath}"`);
        continue;
      }
      add(
        'directory rule match',
        true,
        'auto',
        'directory_rules',
        `matched rule "${rule.directory}" for "${targetPath}"`,
      );

      if (rule.denyProviders && rule.denyProviders.length > 0 && ctx.provider?.id) {
        const matched = deniesProvider(rule.denyProviders, ctx.provider);
        add(
          'denyProviders',
          matched,
          'deny',
          'directory_rules',
          matched
            ? `provider "${ctx.provider.id}" is in denyProviders`
            : `provider "${ctx.provider.id}" is not in denyProviders`,
          matched ? refOf(rule) : undefined,
        );
        if (matched) {
          winnerIndex = steps.length - 1;
          return {
            toolName: tool.name,
            subject: targetPath,
            steps,
            winnerIndex,
            decision: await this.refuse(
              tool,
              input,
              ctx,
              deny(
                `provider "${ctx.provider.id}" is denied in this directory`,
                rule,
                'denyProviders',
                tool.name,
              ),
            ),
          };
        }
      } else {
        add(
          'denyProviders',
          false,
          'deny',
          'directory_rules',
          'rule does not declare denyProviders (or no active provider)',
        );
      }

      if (rule.allowOnlyTools != null) {
        const matched = isToolInList(tool.name, rule.allowOnlyTools);
        add(
          'allowOnlyTools',
          matched,
          'deny',
          'directory_rules',
          matched
            ? `tool "${tool.name}" is in allowOnlyTools — checking remaining targets`
            : `tool "${tool.name}" is NOT in allowOnlyTools — denied`,
          matched ? undefined : refOf(rule),
        );
        if (!matched) {
          winnerIndex = steps.length - 1;
          return {
            toolName: tool.name,
            subject: targetPath,
            steps,
            winnerIndex,
            decision: await this.refuse(
              tool,
              input,
              ctx,
              deny(
                `tool "${tool.name}" is not in the allowOnlyTools list for this directory`,
                rule,
                'allowOnlyTools',
                tool.name,
              ),
            ),
          };
        }
      } else {
        add(
          'allowOnlyTools',
          false,
          'deny',
          'directory_rules',
          'rule does not declare allowOnlyTools',
        );
      }

      if (rule.denyTools) {
        const matched = isToolInList(tool.name, rule.denyTools);
        add(
          'denyTools',
          matched,
          'deny',
          'directory_rules',
          matched
            ? `tool "${tool.name}" is in denyTools — denied`
            : `tool "${tool.name}" is not in denyTools`,
          matched ? refOf(rule) : undefined,
        );
        if (matched) {
          winnerIndex = steps.length - 1;
          return {
            toolName: tool.name,
            subject: targetPath,
            steps,
            winnerIndex,
            decision: await this.refuse(
              tool,
              input,
              ctx,
              deny(`tool "${tool.name}" is denied in this directory`, rule, 'denyTools', tool.name),
            ),
          };
        }
      } else {
        add('denyTools', false, 'deny', 'directory_rules', 'rule does not declare denyTools');
      }
    }

    add(
      'directory rules pass through',
      true,
      'auto',
      'directory_rules',
      'no target constraint matched — delegating to inner policy',
    );
    winnerIndex = steps.length - 1;
    return delegate(targetPaths[0]);
  }
}

/**
 * A rule names a provider by its config key or by the vendor: `anthropic`
 * also covers a second account `work` built from the `anthropic` entry.
 */
function deniesProvider(denied: readonly string[], provider: { readonly id: string }): boolean {
  return providerIdentities(provider).some((id) => denied.includes(id));
}

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
 *   1. `allowOnlyTools` — if non-empty AND the tool is not in the list,
 *      deny. This is the strictest form: it cannot be widened by an
 *      inner-policy allow.
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
 * Path resolution: target paths are extracted from the tool input
 * (same keys as `subjectForToolInput`) and resolved against
 * `ctx.workingDir` (NOT `projectRoot`) so a sub-agent that has changed
 * directory still gets the right rule. The resolved absolute path is
 * then normalized to forward slashes for matching.
 *
 * When no path is present in the input (e.g. a tool call without a
 * `path`/`file`/`url`/`name` subject), the wrapper passes through.
 *
 * Session-level toggle: `ctx.meta['directoryRules'] = false` disables
 * the wrapper entirely (returns inner policy result unchanged) so
 * callers can flip the layer off without re-instantiating the policy.
 */

import * as path from 'node:path';
import type { Context } from '../core/context.js';
import type {
  DirectoryPolicy,
  DirectoryRule,
  PermissionDecision,
  PermissionPolicy,
  PermissionTrace,
  PermissionTraceStep,
} from '../types/permission.js';
import type { Tool } from '../types/tool.js';
import { matchAny, matchGlob } from '../utils/glob-match.js';
import { subjectForToolInput } from '../utils/tool-subject.js';

export interface DirectoryPermissionPolicyOptions {
  /**
   * The directory policy to enforce. Pass an empty policy
   * (`{ schemaVersion: 1, rules: [] }`) to disable enforcement while
   * keeping the wrapper installed — useful as a default-allow stance.
   */
  policy: DirectoryPolicy;
}

const PATH_KEYS = new Set(['path', 'file', 'files', 'target', 'targetPath', 'file_path', 'filePath']);

function extractPathInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Resolve a tool input's target path against `ctx.workingDir` and
 * normalize it to forward slashes. Returns `undefined` when the input
 * has no path-like subject — the caller must then pass through.
 *
 * The returned path is RELATIVE to `ctx.projectRoot` (when the target
 * lives inside the project) so that user-authored globs like
 * `infra/star-star` match the project-relative shape regardless of
 * where the project is checked out on disk. When the target escapes
 * the project root the absolute path is returned unchanged, prefixed
 * with `..` so leading-wildcard patterns still match.
 */
export function resolveTargetPath(input: unknown, ctx: Context): string | undefined {
  // Prefer subjectForToolInput to be consistent with the rest of the
  // permission system; fall back to extractPathInput when the subject
  // is something else (e.g. a shell command) — in that case we want
  // to peek for an explicit path argument the tool might pass alongside.
  const subject = subjectForToolInput('', input, 'path');
  const raw = subject ? subject.replace(/\\/g, '/') : extractPathInput(input);
  if (!raw) return undefined;

  // If the path is absolute, use it directly. Otherwise resolve against
  // workingDir. We deliberately do NOT use projectRoot here — the agent
  // may have set a working directory inside the project, and the rule
  // should follow its position, not the project root.
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ctx.workingDir, raw);
  const normalizedAbsolute = path.resolve(absolute).replace(/\\/g, '/');

  // Strip the project-root prefix so user globs like `infra/**` match
  // the project-relative shape. When the target is outside the project
  // we keep the absolute path with a `..` marker so leading-wildcard
  // patterns like `**/secrets/**` still work.
  const projectRoot = path.resolve(ctx.projectRoot).replace(/\\/g, '/');
  const relative = path.relative(projectRoot, normalizedAbsolute).replace(/\\/g, '/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return relative;
  }
  return relative;
}

/**
 * Compute a "specificity" score for a directory pattern. Patterns with
 * more literal characters (and fewer wildcards) score higher. Used to
 * break ties when multiple rules match the same path.
 *
 * Examples (approximate scores):
 *   infra star-star            → 5
 *   infra slash terraform star-star → 14
 *   secrets subdir star-star   → 8
 *   clients slash acme star-star → 11
 */
function patternSpecificity(pattern: string): number {
  let score = 0;
  for (const ch of pattern) {
    if (ch === '*' || ch === '?' || ch === '[' || ch === ']') continue;
    score++;
  }
  // A trailing /** is the common "directory subtree" marker — give a
  // small bonus so `infra/terraform/**` beats `infra/**` even when the
  // literal count is close.
  if (pattern.endsWith('/**')) score += 1;
  return score;
}

/**
 * Find the most-specific rule that matches the target path. Returns
 * undefined when no rule matches. Specificity is computed as the
 * pattern's literal-character length with a small bonus for trailing
 * `/**`. Ties resolve to first-declared order.
 */
export function matchRule(policy: DirectoryPolicy, targetPath: string): DirectoryRule | undefined {
  let best: { rule: DirectoryRule; specificity: number; index: number } | undefined;
  for (const [index, rule] of policy.rules.entries()) {
    if (!matchGlob(rule.directory, targetPath)) continue;
    const specificity = patternSpecificity(rule.directory);
    if (
      best === undefined ||
      specificity > best.specificity ||
      (specificity === best.specificity && index < best.index)
    ) {
      best = { rule, specificity, index };
    }
  }
  return best?.rule;
}

function deny(
  reason: string,
  rule: DirectoryRule,
  matchedConstraint: 'denyTools' | 'denyProviders' | 'allowOnlyTools',
  toolName: string,
): PermissionDecision {
  const detail = rule.description ? ` (${rule.description})` : '';
  return {
    permission: 'deny',
    source: 'directory_rules',
    reason: `directory rule "${rule.directory}" denied ${matchedConstraint} for "${toolName}"${detail}: ${reason}`,
  };
}

function isToolInList(toolName: string, list: readonly string[]): boolean {
  return matchAny([...list], toolName);
}

export class DirectoryPermissionPolicy implements PermissionPolicy {
  private readonly inner: PermissionPolicy;
  private policy: DirectoryPolicy;

  constructor(inner: PermissionPolicy, options: DirectoryPermissionPolicyOptions) {
    this.inner = inner;
    this.policy = options.policy;
  }

  /** Replace the in-memory directory policy. Does NOT reload from disk. */
  setPolicy(policy: DirectoryPolicy): void {
    this.policy = policy;
  }

  /** Read-only access to the current directory policy for diagnostics. */
  getPolicy(): DirectoryPolicy {
    return {
      schemaVersion: this.policy.schemaVersion,
      rules: this.policy.rules.map((rule) => ({ ...rule })),
    };
  }

  async evaluate(tool: Tool, input: unknown, ctx: Context): Promise<PermissionDecision> {
    // Session-level disable toggle: pass through when the layer is off.
    if (ctx.meta['directoryRules'] === false) {
      return this.inner.evaluate(tool, input, ctx);
    }

    // Empty policy = no rules → pass through.
    if (this.policy.rules.length === 0) {
      return this.inner.evaluate(tool, input, ctx);
    }

    // Try to extract a path. When the tool input has no path subject,
    // the rule layer has nothing to match against → pass through.
    const targetPath = resolveTargetPath(input, ctx);
    if (!targetPath) {
      return this.inner.evaluate(tool, input, ctx);
    }

    const rule = matchRule(this.policy, targetPath);
    if (!rule) {
      return this.inner.evaluate(tool, input, ctx);
    }

    // Provider ban — checked against ctx.provider.id. Independent of
    // the tool name; a model under a denied provider is banned for
    // any tool call targeting this directory.
    if (rule.denyProviders && rule.denyProviders.length > 0 && ctx.provider?.id) {
      if (rule.denyProviders.includes(ctx.provider.id)) {
        return deny(
          `provider "${ctx.provider.id}" is denied in this directory`,
          rule,
          'denyProviders',
          tool.name,
        );
      }
    }

    // allowOnlyTools — most restrictive form. If the tool is not in
    // the allow list, deny. Computed before denyTools so the stricter
    // rule wins regardless of declaration order.
    if (rule.allowOnlyTools && rule.allowOnlyTools.length > 0) {
      if (!isToolInList(tool.name, rule.allowOnlyTools)) {
        return deny(
          `tool "${tool.name}" is not in the allowOnlyTools list for this directory`,
          rule,
          'allowOnlyTools',
          tool.name,
        );
      }
    }

    // denyTools — ban specific tool names (or namespace patterns).
    if (rule.denyTools && rule.denyTools.length > 0) {
      if (isToolInList(tool.name, rule.denyTools)) {
        return deny(
          `tool "${tool.name}" is denied in this directory`,
          rule,
          'denyTools',
          tool.name,
        );
      }
    }

    // Rule matched but no constraint denied this call → pass through
    // to the inner policy. This is intentional: a directory can
    // restrict some operations without authorizing all others.
    return this.inner.evaluate(tool, input, ctx);
  }

  async trust(rule: { tool: string; pattern: string }): Promise<void> {
    return this.inner.trust(rule);
  }

  async deny(rule: { tool: string; pattern: string }): Promise<void> {
    return this.inner.deny(rule);
  }

  denyOnce(rule: { tool: string; pattern: string }): void {
    return this.inner.denyOnce(rule);
  }

  allowOnce(rule: { tool: string; pattern: string }): void {
    return this.inner.allowOnce(rule);
  }

  async reload(): Promise<void> {
    // Directory policy is in-memory only; reload delegates to the
    // inner policy. Hosts that want hot-reload should re-construct
    // the wrapper with a fresh policy.
    await this.inner.reload();
  }

  async explain(tool: Tool, input: unknown, ctx: Context): Promise<PermissionTrace> {
    const steps: PermissionTraceStep[] = [];
    let winnerIndex = -1;

    const add = (
      rule: string,
      matched: boolean,
      decision: 'auto' | 'deny' | 'confirm',
      source: string,
      detail: string,
    ): void => {
      steps.push({ rule, matched, decision, source, detail });
    };

    if (ctx.meta['directoryRules'] === false) {
      add('directory rules disabled', true, 'auto', 'default', 'ctx.meta.directoryRules === false — wrapper is a pass-through');
      winnerIndex = steps.length - 1;
      const innerDecision = await this.inner.evaluate(tool, input, ctx);
      return { toolName: tool.name, subject: null, steps, winnerIndex, decision: innerDecision };
    }
    add('directory rules enabled', false, 'auto', 'default', 'wrapper consults directory policy before inner policy');

    if (this.policy.rules.length === 0) {
      add('empty directory policy', true, 'auto', 'default', 'no directory rules configured');
      winnerIndex = steps.length - 1;
      const innerDecision = await this.inner.evaluate(tool, input, ctx);
      return { toolName: tool.name, subject: null, steps, winnerIndex, decision: innerDecision };
    }
    add('empty directory policy', false, 'auto', 'default', `${this.policy.rules.length} rule(s) configured`);

    const targetPath = resolveTargetPath(input, ctx);
    if (!targetPath) {
      add('no target path', true, 'auto', 'default', 'tool input has no path subject — wrapper cannot match any rule');
      winnerIndex = steps.length - 1;
      const innerDecision = await this.inner.evaluate(tool, input, ctx);
      return { toolName: tool.name, subject: null, steps, winnerIndex, decision: innerDecision };
    }
    add('target path', false, 'auto', 'default', `resolved "${targetPath}"`);

    const rule = matchRule(this.policy, targetPath);
    if (!rule) {
      add('directory rule match', true, 'auto', 'default', `no rule matched "${targetPath}"`);
      winnerIndex = steps.length - 1;
      const innerDecision = await this.inner.evaluate(tool, input, ctx);
      return { toolName: tool.name, subject: null, steps, winnerIndex, decision: innerDecision };
    }
    add('directory rule match', true, 'auto', 'directory_rules', `matched rule "${rule.directory}"`);

    if (rule.denyProviders && rule.denyProviders.length > 0 && ctx.provider?.id) {
      const matched = rule.denyProviders.includes(ctx.provider.id);
      add(
        'denyProviders',
        matched,
        'deny',
        'directory_rules',
        matched
          ? `provider "${ctx.provider.id}" is in denyProviders`
          : `provider "${ctx.provider.id}" is not in denyProviders`,
      );
      if (matched) {
        winnerIndex = steps.length - 1;
        return {
          toolName: tool.name,
          subject: targetPath,
          steps,
          winnerIndex,
          decision: deny(`provider "${ctx.provider.id}" is denied in this directory`, rule, 'denyProviders', tool.name),
        };
      }
    } else {
      add('denyProviders', false, 'deny', 'directory_rules', 'rule does not declare denyProviders (or no active provider)');
    }

    if (rule.allowOnlyTools && rule.allowOnlyTools.length > 0) {
      const matched = isToolInList(tool.name, rule.allowOnlyTools);
      add(
        'allowOnlyTools',
        matched,
        'deny',
        'directory_rules',
        matched
          ? `tool "${tool.name}" is in allowOnlyTools — pass through to inner policy`
          : `tool "${tool.name}" is NOT in allowOnlyTools — denied`,
      );
      if (!matched) {
        winnerIndex = steps.length - 1;
        return {
          toolName: tool.name,
          subject: targetPath,
          steps,
          winnerIndex,
          decision: deny(`tool "${tool.name}" is not in allowOnlyTools list for this directory`, rule, 'allowOnlyTools', tool.name),
        };
      }
    } else {
      add('allowOnlyTools', false, 'deny', 'directory_rules', 'rule does not declare allowOnlyTools');
    }

    if (rule.denyTools && rule.denyTools.length > 0) {
      const matched = isToolInList(tool.name, rule.denyTools);
      add(
        'denyTools',
        matched,
        'deny',
        'directory_rules',
        matched
          ? `tool "${tool.name}" is in denyTools — denied`
          : `tool "${tool.name}" is not in denyTools`,
      );
      if (matched) {
        winnerIndex = steps.length - 1;
        return {
          toolName: tool.name,
          subject: targetPath,
          steps,
          winnerIndex,
          decision: deny(`tool "${tool.name}" is denied in this directory`, rule, 'denyTools', tool.name),
        };
      }
    } else {
      add('denyTools', false, 'deny', 'directory_rules', 'rule does not declare denyTools');
    }

    add('directory rules pass through', true, 'auto', 'directory_rules', 'no constraint matched — delegating to inner policy');
    winnerIndex = steps.length - 1;
    const innerDecision = await this.inner.evaluate(tool, input, ctx);
    return { toolName: tool.name, subject: targetPath, steps, winnerIndex, decision: innerDecision };
  }
}

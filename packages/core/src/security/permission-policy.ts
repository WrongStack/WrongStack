import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '../core/context.js';
import type { InputReader } from '../types/input-reader.js';
import type {
  PermissionDecision,
  PermissionPolicy,
  PermissionTrace,
  TrustPolicy,
} from '../types/permission.js';
import type { Tool } from '../types/tool.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { matchGlob } from '../utils/glob-match.js';
import { LruCache } from '../utils/lru-cache.js';
import { safeParse } from '../utils/safe-json.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import { hasCapability, ToolCapabilities } from './capabilities.js';
import { explainPermissionTrace } from './permission-explain.js';
import { type TrustPolicyDiagnostic, validateTrustPolicy } from './permission-policy-schema.js';
import { attachesWellKnownCredential, isClearlyDestructiveBashCommand } from './yolo-risk.js';

export { AutoApprovePermissionPolicy } from './auto-approve-policy.js';
export {
  alwaysAllowUnavailableReason,
  inputPathLooksSensitive,
  matchesTrust,
  shellCommandLineFromInput,
  shellCommandReadsSensitivePath,
} from './permission-helpers.js';

import {
  alwaysAllowUnavailableReason,
  fsWriteTargetPaths,
  hasShellSubject,
  isInsideAgentStateRoot,
  isSensitiveReadCall,
  matchesCommandTrust,
  matchesTrust,
  permissionFingerprint,
  shellCommandLineFromInput,
} from './permission-helpers.js';

/**
 * Combine an exact-name trust entry with the wildcard entry that also matched.
 *
 * Deny is the union of both levels — a narrow "always allow" must never be able
 * to drop a broad guardrail. Everything permissive (allow / auto / trustWorkdir
 * / denyPrivate) comes from the more specific entry when it says anything, so
 * exact-name rules still win where they are meant to.
 */
export function mergeTrustEntries(
  exact: TrustPolicy[string] | undefined,
  wildcard: TrustPolicy[string] | undefined,
): TrustPolicy[string] | undefined {
  if (!exact) return wildcard;
  if (!wildcard) return exact;

  const deny = [...(wildcard.deny ?? []), ...(exact.deny ?? [])];
  const merged: TrustPolicy[string] = {
    ...wildcard,
    ...exact,
  };
  if (deny.length > 0) merged.deny = [...new Set(deny)];
  return merged;
}

export interface PermissionPolicyOptions {
  trustFile: string;
  yolo?: boolean | undefined;
  yoloDestructive?: boolean | undefined;
  promptDelegate?: (
    tool: Tool,
    input: unknown,
    suggestedPattern: string,
  ) => Promise<'yes' | 'no' | 'always' | 'deny'>;
  inputReader?: InputReader | undefined;
}

export class DefaultPermissionPolicy implements PermissionPolicy {
  private policy: TrustPolicy = {};
  private loaded = false;
  private readonly trustFile: string;
  private yolo: boolean;
  private sessionDenied = new Map<string, boolean>();
  private sessionAllowed = new Map<string, boolean>();
  private promptDelegate?: PermissionPolicyOptions['promptDelegate'] | undefined;
  private wildcardEntries: { pattern: string; value: TrustPolicy[string] }[] = [];
  private _evalCache = new LruCache<string, PermissionDecision>(500);
  private policyDiagnostics: TrustPolicyDiagnostic[] = [];
  private policyInvalid = false;
  private yoloDestructive: boolean;

  constructor(opts: PermissionPolicyOptions) {
    this.trustFile = opts.trustFile;
    this.yolo = opts.yolo ?? false;
    this.yoloDestructive = opts.yoloDestructive ?? false;
    this.promptDelegate = opts.promptDelegate;
  }

  setYoloDestructive(enabled: boolean): void {
    if (this.yoloDestructive !== enabled) this._evalCache.clear();
    this.yoloDestructive = enabled;
  }

  getYoloDestructive(): boolean {
    return this.yoloDestructive;
  }

  private hasAgentStateWriteTarget(tool: Tool, input: unknown, ctx: Context): boolean {
    if (!hasCapability(tool, ToolCapabilities.FS_WRITE)) return false;
    for (const targetPath of fsWriteTargetPaths(input)) {
      const base = ctx.workingDir ?? ctx.cwd;
      const resolved = base ? path.resolve(base, targetPath) : path.resolve(targetPath);
      if (isInsideAgentStateRoot(resolved)) return true;
    }
    return false;
  }

  private yoloBlockedAsDestructive(tool: Tool, input: unknown, ctx: Context): boolean {
    if (!this.effectiveYolo(ctx) || this.yoloDestructive) return false;
    if (this.hasAgentStateWriteTarget(tool, input, ctx)) return true;

    // Binding a well-known third-party credential to a provider endpoint is an
    // exfiltration primitive, not a shell command — so the shell-surface check
    // below never saw it and YOLO auto-approved it. The `baseUrl` has no host
    // allowlist, and prompt injection can reach the tool.
    if (attachesWellKnownCredential(input)) return true;

    const isShellSurface =
      tool.name === 'bash' ||
      tool.name === 'exec' ||
      (tool.capabilities ?? []).includes('shell.arbitrary');
    if (!isShellSurface) return false;
    // H-1 (security report VF-03): `getInputString(input, 'command') ?? …`
    // short-circuited on the bare program name, so `isClearlyDestructiveBashCommand`
    // never saw the args — `{command:'rm', args:['-rf','/']}` classified as "rm".
    // `shellCommandLineFromInput` already joins command/cmd/script with args; it
    // is the whole reason this branch exists.
    const command = shellCommandLineFromInput(input);
    if (!command) return false;
    return isClearlyDestructiveBashCommand(command, ctx.projectRoot);
  }

  setPromptDelegate(delegate: PermissionPolicyOptions['promptDelegate']): void {
    this.promptDelegate = delegate;
  }

  /**
   * YOLO as it applies to ONE conversation.
   *
   * `this.yolo` is a process-wide switch, which is right for a CLI or a TUI —
   * one process, one conversation. A WebUI holds four at once, and YOLO is a
   * per-tab preference stored on each session's own context meta, so reading
   * the process switch meant turning YOLO on in one tab auto-approved the
   * tools of the other three. The instance flag stays as the fallback for
   * hosts (and tests) that never write the meta key.
   */
  private effectiveYolo(ctx?: Pick<Context, 'meta'> | undefined): boolean {
    const scoped = ctx?.meta?.['yolo'];
    return typeof scoped === 'boolean' ? scoped : this.yolo;
  }

  setYolo(enabled: boolean): void {
    if (this.yolo !== enabled) this._evalCache.clear();
    this.yolo = enabled;
  }

  getYolo(): boolean {
    return this.yolo;
  }

  getPolicyDiagnostics(): readonly TrustPolicyDiagnostic[] {
    return this.policyDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async reload(): Promise<void> {
    this.policyDiagnostics = [];
    this.policyInvalid = false;
    try {
      const raw = await fs.readFile(this.trustFile, 'utf8');
      const parsed = safeParse<unknown>(raw);
      if (!parsed.ok) {
        this.policy = {};
        this.policyInvalid = true;
        this.policyDiagnostics = [
          {
            severity: 'error',
            code: 'invalid_json',
            path: '$',
            message: parsed.error ?? 'trust policy is not valid JSON',
          },
        ];
      } else {
        const validation = validateTrustPolicy(parsed.value);
        this.policyDiagnostics = validation.diagnostics;
        if (validation.ok) {
          this.policy = validation.policy;
        } else {
          this.policy = {};
          this.policyInvalid = true;
        }
      }
    } catch (err) {
      this.policy = {};
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.policyInvalid = true;
        this.policyDiagnostics = [
          {
            severity: 'error',
            code: 'read_error',
            path: '$',
            message: err instanceof Error ? err.message : String(err),
          },
        ];
      }
    }
    this.wildcardEntries = [];
    for (const [key, val] of Object.entries(this.policy)) {
      if (key.includes('*')) this.wildcardEntries.push({ pattern: key, value: val });
    }
    this.sessionDenied.clear();
    this.sessionAllowed.clear();
    this._evalCache.clear();
    this.loaded = true;
  }

  private _logDeny(tool: string, subject: string | undefined, reason: string): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'permission.denied',
        message: `Permission denied: ${tool}${subject ? ` (subject: ${subject})` : ''} — ${reason}`,
        tool,
        subject,
        reason,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  async evaluate(tool: Tool, input: unknown, ctx: Context): Promise<PermissionDecision> {
    if (!this.loaded) await this.reload();

    if (this.policyInvalid) {
      this._logDeny(tool.name, undefined, 'trust policy is invalid');
      return {
        permission: 'deny',
        source: 'deny',
        reason: 'trust policy is invalid; refusing tool execution until it is repaired',
      };
    }

    const namespaceEntry = this.findNamespaceEntry(tool.name);
    // Merge rather than select. An exact-name entry used to replace the wildcard
    // entry wholesale, so a single "always allow" on `bash git status` wrote
    // policy["bash"] and silently destroyed every {"*": {deny: [...]}} guardrail
    // for bash. Deny patterns from both levels always apply; the permissive
    // fields come from the more specific entry.
    const entry = mergeTrustEntries(this.policy[tool.name], namespaceEntry);
    const subject = subjectForToolInput(tool.name, input, tool.subjectKey, tool.subjectFields);
    const cacheKey = `${tool.name}::${subject ?? tool.name}`;
    // The DECISION CACHE is scoped to the conversation and to the YOLO value
    // that produced the decision. Shared across four tabs it replayed one
    // tab's YOLO "auto" onto another tab's identical call — the cache would
    // have made the per-session YOLO below decorative.
    //
    // `sessionDenied` / `sessionAllowed` stay process-wide on purpose: a "no"
    // is the user refusing a command, which is a fail-CLOSED answer worth
    // honouring everywhere, and the one-shot allow is consumed by the very
    // call that requested it.
    const evalKey = `${ctx.session?.id ?? '__default__'}::${cacheKey}::${permissionFingerprint(tool)}::y${
      this.effectiveYolo(ctx) ? 1 : 0
    }`;

    if (tool.name !== 'write' && !this.hasAgentStateWriteTarget(tool, input, ctx)) {
      const cached = this._evalCache.get(evalKey);
      if (cached !== undefined) return cached;
    }

    if (this.sessionDenied.has(cacheKey)) {
      this._logDeny(tool.name, subject, 'session soft deny (user pressed no)');
      const decision: PermissionDecision = {
        permission: 'deny',
        source: 'deny',
        reason: 'session soft deny (user pressed no)',
      };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    if (entry?.deny && subject && matchesTrust(entry.deny, subject)) {
      this._logDeny(tool.name, subject, 'matched deny pattern');
      const decision: PermissionDecision = {
        permission: 'deny',
        source: 'deny',
        reason: 'matched deny pattern',
      };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    // Deliberately below the deny branch. A stale one-shot allow must never
    // override a deny rule the user added after granting it.
    if (this.sessionAllowed.has(cacheKey)) {
      this.sessionAllowed.delete(cacheKey);
      const decision: PermissionDecision = {
        permission: 'auto',
        source: 'trust',
        reason: 'session one-shot allow (user pressed yes)',
      };
      return decision;
    }

    if (tool.permission === 'deny') {
      this._logDeny(tool.name, subject, 'tool default deny');
      const decision: PermissionDecision = {
        permission: 'deny',
        source: 'default',
        reason: 'tool default deny',
      };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    // A deny list we could not evaluate is not an absent deny list. Without a
    // subject the deny branch above is skipped, so taking the permissive
    // shortcuts here would auto-approve exactly the call the user tried to
    // block. Fall through to a confirm instead.
    const denyUnevaluated = Boolean(entry?.deny?.length) && subject === undefined;

    const allowMatches = hasShellSubject(tool) ? matchesCommandTrust : matchesTrust;
    if (entry?.allow && subject && allowMatches(entry.allow, subject)) {
      const decision: PermissionDecision = {
        permission: 'auto',
        source: 'trust',
        reason: 'matched allow pattern',
      };
      this._evalCache.set(evalKey, decision);
      return decision;
    }
    if (entry?.auto && !denyUnevaluated) {
      const decision: PermissionDecision = { permission: 'auto', source: 'trust' };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    if (!this.effectiveYolo(ctx) && this.isSensitiveReadCall(tool, input)) {
      if (this.promptDelegate) {
        const userDecision = await this.promptDelegate(tool, input, subject ?? tool.name);
        if (userDecision === 'always') {
          if (subject === undefined) {
            return {
              permission: 'auto',
              source: 'user',
              reason: `approved once — ${alwaysAllowUnavailableReason(tool, input)}`,
            };
          }
          await this.trust({ tool: tool.name, pattern: subject });
          return {
            permission: 'auto',
            source: 'user',
            reason: 'user always-allowed sensitive read',
          };
        }
        if (userDecision === 'deny') {
          await this.deny({ tool: tool.name, pattern: subject ?? tool.name });
          this._logDeny(tool.name, subject, 'user denied sensitive read');
          return { permission: 'deny', source: 'user', reason: 'user denied sensitive read' };
        }
        return {
          permission: userDecision === 'yes' ? 'auto' : 'deny',
          source: 'user',
          reason: 'sensitive read user decision',
        };
      }
      return {
        permission: 'confirm',
        source: 'default',
        riskTier: 'standard',
        reason: 'sensitive file read needs explicit approval',
      };
    }

    if (this.effectiveYolo(ctx)) {
      if (this.yoloBlockedAsDestructive(tool, input, ctx)) {
        return {
          permission: 'confirm',
          source: 'yolo_destructive',
          riskTier: 'destructive',
          reason: 'destructive command needs explicit approval even in YOLO mode',
        };
      }
      const decision: PermissionDecision = { permission: 'auto', source: 'yolo' };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    if (tool.name === 'write' && subject) {
      if (ctx.hasRead(subject) && !isInsideAgentStateRoot(subject)) {
        return {
          permission: 'auto',
          source: 'context',
          reason: 'file already read in this session',
        };
      }
    }

    const hasWriteCap = hasCapability(tool, ToolCapabilities.FS_WRITE);
    const hasShellCap = hasCapability(tool, [
      ToolCapabilities.SHELL_ARBITRARY,
      ToolCapabilities.SHELL_RESTRICTED,
      ToolCapabilities.SHELL_EXEC,
    ]);
    const hasInstallCap = hasCapability(tool, ToolCapabilities.PACKAGE_INSTALL);
    const hasConfigCap = hasCapability(tool, ToolCapabilities.CONFIG_MUTATE);
    const hasSubagentCap = hasCapability(tool, ToolCapabilities.SUBAGENT_SPAWN);
    const isMutating =
      tool.mutating ||
      hasWriteCap ||
      hasShellCap ||
      hasInstallCap ||
      hasConfigCap ||
      hasSubagentCap;
    if (tool.permission === 'auto' && !isMutating) {
      const decision: PermissionDecision = { permission: 'auto', source: 'default' };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    if (this.promptDelegate) {
      const decision = await this.promptDelegate(tool, input, subject ?? tool.name);
      if (decision === 'always') {
        if (subject === undefined) {
          return {
            permission: 'auto',
            source: 'user',
            reason: `approved once — ${alwaysAllowUnavailableReason(tool, input)}`,
          };
        }
        await this.trust({ tool: tool.name, pattern: subject });
        return { permission: 'auto', source: 'user', reason: 'user always-allowed' };
      }
      if (decision === 'deny') {
        await this.deny({ tool: tool.name, pattern: subject ?? tool.name });
        this._logDeny(tool.name, subject, 'user denied');
        return { permission: 'deny', source: 'user', reason: 'user denied' };
      }
      return { permission: decision === 'yes' ? 'auto' : 'deny', source: 'user' };
    }
    return { permission: 'confirm', source: 'default' };
  }

  // Delegates to the shared helper so the subagent policy applies the exact
  // same rule — see `isSensitiveReadCall` in ./permission-helpers.ts.
  private isSensitiveReadCall(tool: Tool, input: unknown): boolean {
    return isSensitiveReadCall(tool, input);
  }

  async trust(rule: { tool: string; pattern: string }): Promise<void> {
    if (!this.loaded) await this.reload();
    if (this.policyInvalid) {
      throw new Error('Cannot update trust rules while trust.json is invalid; repair it first.');
    }
    const entry = this.policy[rule.tool] ?? {};
    entry.allow = Array.from(new Set([...(entry.allow ?? []), rule.pattern]));
    this.policy[rule.tool] = entry;
    this._evalCache.clear();
    try {
      await atomicWrite(this.trustFile, JSON.stringify(this.policy, null, 2));
    } catch (err) {
      const existing = this.policy[rule.tool];
      if (existing?.allow) {
        const idx = existing.allow.indexOf(rule.pattern);
        if (idx !== -1) existing.allow.splice(idx, 1);
      }
      throw err;
    }
  }

  async deny(rule: { tool: string; pattern: string }): Promise<void> {
    if (!this.loaded) await this.reload();
    if (this.policyInvalid) {
      throw new Error('Cannot update deny rules while trust.json is invalid; repair it first.');
    }
    const entry = this.policy[rule.tool] ?? {};
    entry.deny = Array.from(new Set([...(entry.deny ?? []), rule.pattern]));
    this.policy[rule.tool] = entry;
    this._evalCache.clear();
    try {
      await atomicWrite(this.trustFile, JSON.stringify(this.policy, null, 2));
    } catch (err) {
      const existing = this.policy[rule.tool];
      if (existing?.deny) {
        const idx = existing.deny.indexOf(rule.pattern);
        if (idx !== -1) existing.deny.splice(idx, 1);
      }
      throw err;
    }
  }

  denyOnce(rule: { tool: string; pattern: string }): void {
    this.sessionDenied.set(`${rule.tool}::${rule.pattern}`, true);
    this._evalCache.clear();
  }

  allowOnce(rule: { tool: string; pattern: string }): void {
    this.sessionAllowed.set(`${rule.tool}::${rule.pattern}`, true);
    this._evalCache.clear();
  }

  async explain(tool: Tool, input: unknown, ctx: Context): Promise<PermissionTrace> {
    if (!this.loaded) await this.reload();
    return explainPermissionTrace(
      {
        policy: this.policy,
        policyInvalid: this.policyInvalid,
        wildcardEntries: this.wildcardEntries,
        sessionDenied: this.sessionDenied,
        sessionAllowed: this.sessionAllowed,
        yolo: this.effectiveYolo(ctx),
        promptDelegatePresent: this.promptDelegate !== undefined,
        isSensitiveReadCall: (t, inp) => this.isSensitiveReadCall(t, inp),
        yoloBlockedAsDestructive: (t, inp, c) => this.yoloBlockedAsDestructive(t, inp, c),
      },
      tool,
      input,
      ctx,
    );
  }

  private findNamespaceEntry(toolName: string): TrustPolicy[string] | undefined {
    for (const { pattern, value } of this.wildcardEntries) {
      if (matchGlob(pattern, toolName)) return value;
    }
    return undefined;
  }
}

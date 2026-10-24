import type { AgentContext } from '@wrongstack/contracts/types/context';
import type {
  PermissionDecision,
  PermissionPolicy,
  PermissionTrace,
} from '@wrongstack/contracts/types/permission';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { subjectForToolInput } from '../utils/tool-subject.js';
import { isAgentStateWriteTarget } from './agent-state-sensitivity.js';
import { hasCapability, ToolCapabilities } from './capabilities.js';
import { explainPermissionTrace } from './permission-explain.js';
import {
  alwaysAllowUnavailableReason,
  hasShellSubject,
  matchesCommandTrust,
  matchesTrust,
  permissionFingerprint,
  refusalUnderYolo,
} from './permission-helpers.js';
import { PermissionPolicyState } from './permission-policy-state.js';
import { listTrustPolicyRules, type UnnumberedPermissionRule } from './permission-rules.js';
import { isYoloLockedOff } from './process-lockdown.js';
import {
  DEFAULT_ALWAYS_TRUST_TTL_MS,
  exactApprovalKey,
  isPersistentApproval,
  isScopedApprovalPattern,
  matchingApprovalScope,
  scopedApprovalPattern,
} from './scoped-approval.js';
import {
  describeSessionPermissionOverride,
  matchSessionPermissionOverride,
  readSessionPermissionOverrides,
  sessionDenyUnevaluated,
  sessionOverridesFingerprint,
} from './session-permission-overrides.js';
import { mergeTrustEntries } from './trust-entry.js';
import { LOCKED_DESTRUCTIVE_KINDS } from './yolo-risk.js';

export { AutoApprovePermissionPolicy } from './auto-approve-policy.js';
export {
  alwaysAllowUnavailableReason,
  inputPathLooksSensitive,
  matchesTrust,
  shellCommandLineFromInput,
  shellCommandReadsSensitivePath,
} from './permission-helpers.js';
export type { PermissionPolicyOptions } from './permission-policy-state.js';
export { mergeTrustEntries } from './trust-entry.js';

export { DEFAULT_ALWAYS_TRUST_TTL_MS };

export class DefaultPermissionPolicy extends PermissionPolicyState implements PermissionPolicy {
  async evaluate(tool: Tool, input: unknown, ctx: AgentContext): Promise<PermissionDecision> {
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
    const overrides = readSessionPermissionOverrides(ctx);
    const evalKey = `${ctx.session?.id ?? '__default__'}::${cacheKey}::${permissionFingerprint(tool)}::${exactApprovalKey(input, ctx)}::y${
      this.effectiveYolo(ctx) ? 1 : 0
    }::p${this.effectiveYoloPlus(ctx) ? 1 : 0}::o${sessionOverridesFingerprint(overrides)}`;

    if (tool.name !== 'write' && !this.hasAgentStateWriteTarget(tool, input, ctx)) {
      const cached = this._evalCache.get(evalKey);
      if (cached !== undefined) return cached;
    }

    // The user's own refusals. Off and YOLO+ refuse; YOLO asks instead
    // (`refusalUnderYolo`).
    const yoloMode = { yolo: this.effectiveYolo(ctx), yoloPlus: this.effectiveYoloPlus(ctx) };
    const refuse = (refusal: PermissionDecision): PermissionDecision => {
      const decision = refusalUnderYolo(refusal, yoloMode);
      if (decision.permission === 'deny') {
        this._logDeny(tool.name, subject, decision.reason ?? 'deny');
      }
      this._evalCache.set(evalKey, decision);
      return decision;
    };

    if (this.sessionDenied.has(cacheKey)) {
      return refuse({
        permission: 'deny',
        source: 'deny',
        reason: 'session soft deny (user pressed no)',
      });
    }

    if (entry?.deny && subject && matchesTrust(entry.deny, subject)) {
      return refuse({ permission: 'deny', source: 'deny', reason: 'matched deny pattern' });
    }

    const sessionDeny = matchSessionPermissionOverride(overrides, 'deny', tool, subject);
    if (sessionDeny) {
      return refuse({
        permission: 'deny',
        source: 'session_override',
        reason: `session rule: ${describeSessionPermissionOverride(sessionDeny.override)}`,
      });
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
    const denyUnevaluated =
      (Boolean(entry?.deny?.length) && subject === undefined) ||
      sessionDenyUnevaluated(overrides, tool, subject);

    // YOLO+: the user allowed everything. Every refusal they wrote themselves
    // is above this line and still wins (deny rules, a "no" this session, a
    // tool that is deny by default); everything that would only have ASKED —
    // the destructive kinds, the locked ones, sensitive reads, broad approvals
    // stopping short of a destructive call — runs.
    if (this.effectiveYoloPlus(ctx)) {
      // A deny list that could not be checked might be refusing this very
      // call, and YOLO+ has no prompt to fall back to — so refuse rather than
      // let "allow everything" quietly outrank a rule the user wrote.
      if (denyUnevaluated) {
        return refuse({
          permission: 'deny',
          source: 'deny',
          reason: 'a deny rule for this tool could not be evaluated for this call',
        });
      }
      const decision: PermissionDecision = {
        permission: 'auto',
        source: 'yolo',
        reason: 'YOLO+ — every call is allowed',
        allowAll: true,
      };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    // The user's own rule for this session: honoured like an approval given at
    // a prompt, and stopped short by the same things (a sensitive read, a
    // destructive call).
    // `--restricted` promises that every write asks, which is why it refuses
    // `--allowed-tools`. A session rule is the same pre-approval, and one can
    // arrive with a resumed journal rather than from this run's user
    // (WS-2026-09-26-04) — so under that lockdown allows are not honoured.
    // Denies still are.
    const sessionAllow =
      denyUnevaluated || isYoloLockedOff()
        ? undefined
        : matchSessionPermissionOverride(overrides, 'allow', tool, subject);
    if (sessionAllow && (this.effectiveYolo(ctx) || !this.isSensitiveReadCall(tool, input))) {
      const rule = describeSessionPermissionOverride(sessionAllow.override);
      if (this.broadApprovalStopsShort(tool, input, ctx)) {
        return {
          permission: 'confirm',
          source: 'session_override',
          riskTier: 'destructive',
          reason: `session rule (${rule}) does not cover destructive calls`,
        };
      }
      return {
        permission: 'auto',
        source: 'session_override',
        reason: `session rule: ${rule}`,
        approvalGrant: true,
      };
    }

    // W6 #9: an `always` answer persists a trust rule, and it used to persist
    // forever. An EXPIRED rule is treated as absent, not as a deny — the call
    // falls through to the normal confirm path below, so expiry re-prompts
    // rather than blocks. Absent `allowUntil` (a hand-authored entry) never
    // expires.
    const allowUnexpired = entry?.allowUntil === undefined || Date.now() < entry.allowUntil;
    const trustScope =
      allowUnexpired && !denyUnevaluated
        ? matchingApprovalScope(entry?.allow ?? [], tool, input, ctx)
        : undefined;
    const launchAllowed =
      trustScope === undefined && !denyUnevaluated && this.isLaunchAllowed(tool.name);
    const matchedScope = trustScope ?? (launchAllowed ? 'tool' : undefined);
    // A broad grant ("Tool, any input") was given for the call the user saw,
    // not for credential / agent-state reads the sensitive-read gate below
    // exists to surface. Those still prompt unless the grant was for this
    // exact input — the same carve-out destructive calls get.
    const scope =
      matchedScope !== undefined &&
      matchedScope !== 'exact' &&
      !this.effectiveYolo(ctx) &&
      this.isSensitiveReadCall(tool, input)
        ? undefined
        : matchedScope;
    if (scope) {
      const destructive = this.broadApprovalStopsShort(tool, input, ctx);
      if (scope !== 'exact' && destructive) {
        return {
          permission: 'confirm',
          source: 'trust',
          riskTier: 'destructive',
          reason: 'Broad approval does not cover destructive calls',
        };
      }
      return {
        permission: 'auto',
        source: 'trust',
        reason: launchAllowed ? 'allowed by --allowed-tools' : `matched ${scope} approval`,
        ...(launchAllowed ? { launchGrant: true as const } : { approvalGrant: true as const }),
      };
    }
    const allowMatches = hasShellSubject(tool) ? matchesCommandTrust : matchesTrust;
    if (
      allowUnexpired &&
      entry?.allow &&
      subject &&
      allowMatches(
        entry.allow.filter((p) => !isScopedApprovalPattern(p)),
        subject,
      )
    ) {
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
        if (isPersistentApproval(userDecision)) {
          if (subject === undefined && userDecision === 'always') {
            return {
              permission: 'auto',
              source: 'user',
              reason: `approved once — ${alwaysAllowUnavailableReason(tool, input)}`,
            };
          }
          await this.trust({
            tool: tool.name,
            pattern: scopedApprovalPattern(userDecision, tool, input, ctx, subject ?? tool.name),
            ttlMs: DEFAULT_ALWAYS_TRUST_TTL_MS,
          });
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

    // YOLO is the broad auto-approval switch. Tool-declared `confirm` remains
    // the normal-mode default, while explicit denies and the destructive-kind
    // check inside this branch still win.
    if (this.effectiveYolo(ctx)) {
      // A deny list that could not be checked for this call might be refusing
      // it: YOLO stops and asks rather than running it unseen.
      if (denyUnevaluated) {
        return refuse({
          permission: 'deny',
          source: 'deny',
          reason: 'a deny rule for this tool could not be evaluated for this call',
        });
      }
      const gatedKind = this.gatedDestructiveKind(tool, input, ctx);
      if (gatedKind !== undefined) {
        return {
          permission: 'confirm',
          source: 'yolo_destructive',
          riskTier: 'destructive',
          // Naming the kind is what makes the prompt actionable: the user can
          // see WHICH category held this, and turn that one off in settings.
          reason: LOCKED_DESTRUCTIVE_KINDS.has(gatedKind)
            ? `${gatedKind} always needs explicit approval — it can disable approval itself`
            : `${gatedKind} needs explicit approval even in YOLO mode (settings: autonomy.yoloConfirm)`,
        };
      }
      const decision: PermissionDecision = { permission: 'auto', source: 'yolo' };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    if (tool.name === 'write' && subject) {
      if (ctx.hasRead(subject) && !isAgentStateWriteTarget(subject)) {
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
      if (isPersistentApproval(decision)) {
        if (subject === undefined && decision === 'always') {
          return {
            permission: 'auto',
            source: 'user',
            reason: `approved once — ${alwaysAllowUnavailableReason(tool, input)}`,
          };
        }
        await this.trust({
          tool: tool.name,
          pattern: scopedApprovalPattern(decision, tool, input, ctx, subject ?? tool.name),
          ttlMs: DEFAULT_ALWAYS_TRUST_TTL_MS,
        });
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

  async explain(tool: Tool, input: unknown, ctx: AgentContext): Promise<PermissionTrace> {
    if (!this.loaded) await this.reload();
    return explainPermissionTrace(
      {
        policy: this.policy,
        policyInvalid: this.policyInvalid,
        wildcardEntries: this.wildcardEntries,
        sessionDenied: this.sessionDenied,
        sessionAllowed: this.sessionAllowed,
        yolo: this.effectiveYolo(ctx),
        yoloPlus: this.effectiveYoloPlus(ctx),
        promptDelegatePresent: this.promptDelegate !== undefined,
        isDestructiveCall: (t, inp, c) => this.broadApprovalStopsShort(t, inp, c),
        isSensitiveReadCall: (t, inp) => this.isSensitiveReadCall(t, inp),
        yoloBlockedAsDestructive: (t, inp, c) => this.yoloBlockedAsDestructive(t, inp, c),
        isLaunchAllowed: (name) => this.isLaunchAllowed(name),
        launchAllowedTools: this.launchAllowedTools,
      },
      tool,
      input,
      ctx,
    );
  }

  async listRules(ctx?: AgentContext | undefined): Promise<UnnumberedPermissionRule[]> {
    if (!this.loaded) await this.reload();
    return listTrustPolicyRules({
      policy: this.policy,
      policyInvalid: this.policyInvalid,
      wildcardEntries: this.wildcardEntries,
      sessionDenied: this.sessionDenied,
      sessionAllowed: this.sessionAllowed,
      launchAllowedTools: this.launchAllowedTools,
      yolo: this.effectiveYolo(ctx),
      yoloConfirmKinds: this.yoloConfirmKinds,
      overrides: readSessionPermissionOverrides(ctx),
    });
  }
}

import type { AgentContext } from '@wrongstack/contracts/types/context';
import type {
  PermissionTrace,
  PermissionTraceStep,
  TrustPolicy,
} from '@wrongstack/contracts/types/permission';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { matchGlob } from '../utils/glob-match.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import { isAgentStateWriteTarget } from './agent-state-sensitivity.js';
import {
  capabilityDowngradesToConfirm,
  getDangerousCapabilities,
  hasCapability,
  ToolCapabilities,
} from './capabilities.js';
import {
  hasShellSubject,
  matchesCommandTrust,
  matchesTrust,
  refusalUnderYolo,
} from './permission-helpers.js';
import {
  allowedToolsRef,
  permissionRuleRef,
  trustAllowRef,
  trustAutoRef,
  trustDenyRef,
  trustScopedRef,
} from './permission-rules.js';
import { isYoloLockedOff } from './process-lockdown.js';
import { isScopedApprovalPattern, matchingApprovalScope } from './scoped-approval.js';
import {
  describeSessionPermissionOverride,
  matchSessionPermissionOverride,
  readSessionPermissionOverrides,
  sessionDenyUnevaluated,
} from './session-permission-overrides.js';
import { mergeTrustEntries } from './trust-entry.js';

export interface PermissionExplainContext {
  policy: TrustPolicy;
  policyInvalid: boolean;
  wildcardEntries: { pattern: string; value: TrustPolicy[string] }[];
  sessionDenied: Map<string, boolean>;
  sessionAllowed: Map<string, boolean>;
  yolo: boolean;
  /** YOLO+ — allow every call no deny rule refuses. */
  yoloPlus?: boolean | undefined;
  promptDelegatePresent: boolean;
  isSensitiveReadCall(tool: Tool, input: unknown): boolean;
  isDestructiveCall?(tool: Tool, input: unknown, ctx: AgentContext): boolean;
  yoloBlockedAsDestructive(tool: Tool, input: unknown, ctx: AgentContext): boolean;
  /** `--allowed-tools` membership; mirrors evaluate()'s launch tool scope. */
  isLaunchAllowed?(toolName: string): boolean;
  /** The `--allowed-tools` patterns, to name the one that matched. */
  launchAllowedTools?: readonly string[] | undefined;
}

export function explainPermissionTrace(
  state: PermissionExplainContext,
  tool: Tool,
  input: unknown,
  ctx: AgentContext,
): PermissionTrace {
  const subject = subjectForToolInput(tool.name, input, tool.subjectKey, tool.subjectFields);
  const steps: PermissionTraceStep[] = [];
  let winnerIndex = -1;

  const add = (
    rule: string,
    matched: boolean,
    decision: 'auto' | 'deny' | 'confirm',
    source: string,
    detail: string,
    ref?: string | undefined,
  ): void => {
    steps.push({ rule, matched, decision, source, detail, ...(ref !== undefined ? { ref } : {}) });
  };

  // A refusal the user wrote — the same rule as evaluate(): off and YOLO+
  // refuse, YOLO asks (`refusalUnderYolo`).
  const yoloMode = { yolo: state.yolo, yoloPlus: state.yoloPlus === true };
  const refused = (
    rule: string,
    detail: string,
    ref: string | undefined,
    refusal: PermissionTrace['decision'],
  ): PermissionTrace => {
    const decision = refusalUnderYolo(refusal, yoloMode);
    const asks = decision.permission === 'confirm';
    add(
      rule,
      true,
      asks ? 'confirm' : 'deny',
      asks ? (decision.source ?? 'yolo_destructive') : (refusal.source ?? 'deny'),
      asks ? `${detail} — YOLO asks instead of refusing` : detail,
      ref,
    );
    return { toolName: tool.name, subject, steps, winnerIndex: steps.length - 1, decision };
  };

  // 1. Policy invalid
  if (state.policyInvalid) {
    add('policy invalid', true, 'deny', 'deny', 'trust policy is invalid; all tools are denied');
    winnerIndex = 0;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: { permission: 'deny', source: 'deny', reason: 'trust policy is invalid' },
    };
  }
  add('policy valid', false, 'auto', 'default', 'trust policy loaded successfully');

  // Namespace entry resolution
  let namespaceEntry: TrustPolicy[string] | undefined;
  for (const { pattern, value } of state.wildcardEntries) {
    if (matchGlob(pattern, tool.name)) {
      namespaceEntry = value;
      break;
    }
  }
  const entry = mergeTrustEntries(state.policy[tool.name], namespaceEntry);
  const namespaceSource = namespaceEntry
    ? `wildcard entry matched (${Object.keys(state.policy).find((k) => k.includes('*') && matchGlob(k, tool.name))})`
    : 'no namespace match';

  // 2. Session soft deny
  const cacheKey = `${tool.name}::${subject ?? tool.name}`;
  if (state.sessionDenied.has(cacheKey)) {
    return refused(
      'session soft deny',
      'user pressed "no" earlier in this session — blocked until reload',
      permissionRuleRef.answer(cacheKey),
      { permission: 'deny', source: 'deny', reason: 'session soft deny (user pressed no)' },
    );
  }
  add(
    'session soft deny',
    false,
    'deny',
    'deny',
    'no session-level soft deny for this tool+subject',
  );

  // 4. Trust deny
  if (entry?.deny && subject && matchesTrust(entry.deny, subject)) {
    return refused(
      'trust deny',
      `subject "${subject}" matched a deny pattern in trust file`,
      trustDenyRef(state, tool.name, subject),
      { permission: 'deny', source: 'deny', reason: 'matched deny pattern' },
    );
  }
  add(
    'trust deny',
    false,
    'deny',
    'deny',
    `no deny pattern matched (namespace: ${namespaceSource})`,
  );

  // Session rule deny (`/permissions deny`)
  const overrides = readSessionPermissionOverrides(ctx);
  const sessionDeny = matchSessionPermissionOverride(overrides, 'deny', tool, subject ?? undefined);
  if (sessionDeny) {
    const reason = `session rule: ${describeSessionPermissionOverride(sessionDeny.override)}`;
    return refused('session rule deny', reason, permissionRuleRef.session(sessionDeny.index), {
      permission: 'deny',
      source: 'session_override',
      reason,
    });
  }
  add('session rule deny', false, 'deny', 'session_override', 'no session deny rule matched');

  // 3. Session soft allow (one-shot)
  if (state.sessionAllowed.has(cacheKey)) {
    add(
      'session soft allow',
      true,
      'auto',
      'trust',
      'user pressed "yes" in current session — one-shot auto-approve (consumed)',
      permissionRuleRef.answer(cacheKey),
    );
    winnerIndex = steps.length - 1;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: {
        permission: 'auto',
        source: 'trust',
        reason: 'session one-shot allow (user pressed yes)',
      },
    };
  }
  add(
    'session soft allow',
    false,
    'auto',
    'trust',
    'no session-level one-shot allow for this tool+subject',
  );

  // 5. Tool default deny
  if (tool.permission === 'deny') {
    add(
      'tool default deny',
      true,
      'deny',
      'default',
      `tool "${tool.name}" has permission: deny by default`,
    );
    winnerIndex = steps.length - 1;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: { permission: 'deny', source: 'default', reason: 'tool default deny' },
    };
  }
  add(
    'tool default deny',
    false,
    'deny',
    'default',
    `tool "${tool.name}" has permission: "${tool.permission}"`,
  );

  const allowUnexpired = entry?.allowUntil === undefined || Date.now() < entry.allowUntil;
  const denyUnevaluated =
    (Boolean(entry?.deny?.length) && subject === undefined) ||
    sessionDenyUnevaluated(overrides, tool, subject ?? undefined);

  // YOLO+ — the same place evaluate() decides it: below every refusal, and
  // refusing when a deny list could not be checked for this call.
  const unevaluatedRefusal = {
    permission: 'deny',
    source: 'deny',
    reason: 'a deny rule for this tool could not be evaluated for this call',
  } as const;
  if (state.yoloPlus) {
    if (denyUnevaluated) {
      return refused('yolo+', unevaluatedRefusal.reason, undefined, unevaluatedRefusal);
    }
    winnerIndex = steps.length;
    add('yolo+', true, 'auto', 'yolo', 'YOLO+ is active — every call no deny rule refuses runs');
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: {
        permission: 'auto',
        source: 'yolo',
        reason: 'YOLO+ — every call is allowed',
        allowAll: true,
      },
    };
  }
  add('yolo+', false, 'auto', 'yolo', 'YOLO+ is not active');

  // Session rule allow (`/permissions allow`) — not honoured under `--restricted`,
  // exactly as evaluate() refuses it.
  const sessionAllow =
    denyUnevaluated || isYoloLockedOff()
      ? undefined
      : matchSessionPermissionOverride(overrides, 'allow', tool, subject ?? undefined);
  if (sessionAllow && (state.yolo || !state.isSensitiveReadCall(tool, input))) {
    const rule = describeSessionPermissionOverride(sessionAllow.override);
    const destructive =
      state.isDestructiveCall?.(tool, input, ctx) ??
      state.yoloBlockedAsDestructive(tool, input, ctx);
    add(
      'session rule allow',
      true,
      destructive ? 'confirm' : 'auto',
      'session_override',
      destructive
        ? `session rule (${rule}) does not cover destructive calls`
        : `session rule: ${rule}`,
      permissionRuleRef.session(sessionAllow.index),
    );
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex: steps.length - 1,
      decision: destructive
        ? {
            permission: 'confirm',
            source: 'session_override',
            riskTier: 'destructive',
            reason: `session rule (${rule}) does not cover destructive calls`,
          }
        : {
            permission: 'auto',
            source: 'session_override',
            reason: `session rule: ${rule}`,
            approvalGrant: true,
          },
    };
  }
  add(
    'session rule allow',
    false,
    'auto',
    'session_override',
    sessionAllow
      ? 'a session allow rule matched, but a sensitive read still asks'
      : 'no session allow rule matched',
  );

  const trustScope =
    entry?.allow && !denyUnevaluated && allowUnexpired
      ? matchingApprovalScope(entry.allow, tool, input, ctx)
      : undefined;
  const launchAllowed =
    trustScope === undefined && !denyUnevaluated && state.isLaunchAllowed?.(tool.name) === true;
  const matchedScope = trustScope ?? (launchAllowed ? 'tool' : undefined);
  // Mirror of evaluate(): a broad scope does not cover a sensitive read.
  const scope =
    matchedScope !== undefined &&
    matchedScope !== 'exact' &&
    !state.yolo &&
    state.isSensitiveReadCall(tool, input)
      ? undefined
      : matchedScope;
  if (scope) {
    const destructive =
      scope !== 'exact' &&
      (state.isDestructiveCall?.(tool, input, ctx) ??
        state.yoloBlockedAsDestructive(tool, input, ctx));
    const permission = destructive ? 'confirm' : 'auto';
    add(
      'scoped trust',
      true,
      permission,
      'trust',
      `${launchAllowed ? 'allowed by --allowed-tools' : `matched ${scope} approval`}${destructive ? '; destructive call still requires approval' : ''}`,
      launchAllowed
        ? allowedToolsRef(state.launchAllowedTools ?? [], tool.name)
        : trustScopedRef(state, tool, input, ctx),
    );
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex: steps.length - 1,
      decision: {
        permission,
        source: 'trust',
        ...(destructive ? { riskTier: 'destructive' as const } : {}),
        ...(destructive
          ? {}
          : launchAllowed
            ? { launchGrant: true as const }
            : { approvalGrant: true as const }),
      },
    };
  }
  // 6. Trust allow
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
    add(
      'trust allow',
      true,
      'auto',
      'trust',
      `subject "${subject}" matched an allow pattern in trust file`,
      trustAllowRef(state, tool.name, (p) => allowMatches([p], subject)),
    );
    winnerIndex = steps.length - 1;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: { permission: 'auto', source: 'trust', reason: 'matched allow pattern' },
    };
  }
  add(
    'trust allow',
    false,
    'auto',
    'trust',
    `no allow pattern matched (namespace: ${namespaceSource})`,
  );

  // 7. Trust auto
  if (entry?.auto && !denyUnevaluated) {
    add(
      'trust auto',
      true,
      'auto',
      'trust',
      `trust file has auto: true for "${tool.name}"`,
      trustAutoRef(state, tool.name),
    );
    winnerIndex = steps.length - 1;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: { permission: 'auto', source: 'trust', reason: 'trust auto' },
    };
  }
  add('trust auto', false, 'auto', 'trust', `no auto flag for "${tool.name}" in trust file`);

  // 8. Sensitive read (only checked when not YOLO)
  if (!state.yolo && state.isSensitiveReadCall(tool, input)) {
    const hasDelegate = state.promptDelegatePresent;
    add(
      'sensitive read',
      true,
      'confirm',
      'default',
      hasDelegate
        ? 'sensitive file read detected — would prompt user for approval'
        : 'sensitive file read detected — returns confirm (no prompt delegate)',
    );
    winnerIndex = steps.length - 1;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: {
        permission: 'confirm',
        source: 'default',
        riskTier: 'standard',
        reason: 'sensitive file read needs explicit approval',
      },
    };
  }
  add(
    'sensitive read',
    false,
    'confirm',
    'default',
    'not a sensitive read call (or YOLO bypasses this check)',
  );

  // 9. YOLO
  if (state.yolo) {
    if (denyUnevaluated) {
      return refused('yolo', unevaluatedRefusal.reason, undefined, unevaluatedRefusal);
    }
    if (state.yoloBlockedAsDestructive(tool, input, ctx)) {
      add(
        'yolo destructive gate',
        true,
        'confirm',
        'yolo_destructive',
        'YOLO is active but this is a clearly destructive command — still asking',
      );
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: {
          permission: 'confirm',
          source: 'yolo_destructive',
          riskTier: 'destructive',
          reason: 'destructive command needs explicit approval even in YOLO mode',
        },
      };
    }
    add('yolo', true, 'auto', 'yolo', 'YOLO mode is active — auto-approving every non-denied call');
    winnerIndex = steps.length - 1;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: { permission: 'auto', source: 'yolo' },
    };
  }
  add('yolo', false, 'auto', 'yolo', 'YOLO mode is not active');

  // 10. Write-tool smart bypass
  if (tool.name === 'write' && subject) {
    const isAgentState = isAgentStateWriteTarget(subject);
    const hasRead = ctx.hasRead(subject) && !isAgentState;
    add(
      'write smart bypass',
      hasRead,
      'auto',
      'context',
      isAgentState
        ? `file "${subject}" is WrongStack's own state — bypass never applies, write always confirms`
        : hasRead
          ? `file "${subject}" was already read in this session — auto-approving write`
          : `file "${subject}" was not read in this session — bypass does not apply`,
    );
    if (hasRead) {
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: {
          permission: 'auto',
          source: 'context',
          reason: 'file already read in this session',
        },
      };
    }
  } else {
    add(
      'write smart bypass',
      false,
      'auto',
      'context',
      'tool is not "write" or has no subject — bypass does not apply',
    );
  }

  // 11. Tool default auto + non-mutating
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
    tool.mutating || hasWriteCap || hasShellCap || hasInstallCap || hasConfigCap || hasSubagentCap;
  if (tool.permission === 'auto' && !isMutating) {
    add(
      'safe default auto',
      true,
      'auto',
      'default',
      `tool "${tool.name}" has auto permission and is not mutating — safe to auto-approve`,
    );
    winnerIndex = steps.length - 1;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: { permission: 'auto', source: 'default' },
    };
  }
  add(
    'mutating default confirm',
    true,
    'confirm',
    'default',
    isMutating
      ? `tool "${tool.name}" is mutating (default auto not enough) — needs confirmation`
      : `tool "${tool.name}" has "${tool.permission}" permission — needs confirmation`,
  );

  // 12. Final fallback — confirm
  winnerIndex = steps.length - 1;
  const hasDelegate = state.promptDelegatePresent;
  return {
    toolName: tool.name,
    subject,
    steps,
    winnerIndex,
    decision: {
      permission: 'confirm',
      source: 'default',
      ...(hasDelegate ? { reason: 'would prompt user via delegate' } : {}),
    },
  };
}

/**
 * Add the executor's last gate to a policy trace: a trust `auto` for a
 * dangerous-capability tool still confirms (see
 * `capabilityDowngradesToConfirm`). A policy trace alone stops one step short
 * of what the agent does, and reports `auto` for a call it will ask about.
 */
export function withExecutorGate(
  trace: PermissionTrace,
  tool: Tool,
  yolo: boolean,
): PermissionTrace {
  if (!capabilityDowngradesToConfirm(trace.decision, tool, yolo)) return trace;
  const steps: PermissionTraceStep[] = [
    ...trace.steps,
    {
      rule: 'dangerous capability',
      matched: true,
      decision: 'confirm',
      source: 'executor',
      detail: `"${tool.name}" has ${getDangerousCapabilities(tool).join(', ')}: a trust entry alone does not skip the confirmation (YOLO, --allowed-tools or an approval given at a prompt does)`,
    },
  ];
  return {
    ...trace,
    steps,
    winnerIndex: steps.length - 1,
    decision: {
      permission: 'confirm',
      source: trace.decision.source,
      reason: 'a trust entry alone does not auto-approve a dangerous-capability tool',
    },
  };
}

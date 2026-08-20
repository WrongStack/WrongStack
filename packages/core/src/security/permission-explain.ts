import type { Context } from '../core/context.js';
import type { PermissionTrace, PermissionTraceStep, TrustPolicy } from '../types/permission.js';
import type { Tool } from '../types/tool.js';
import { matchGlob } from '../utils/glob-match.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import { hasCapability, ToolCapabilities } from './capabilities.js';
import { isInsideAgentStateRoot, matchesTrust } from './permission-helpers.js';

export interface PermissionExplainContext {
  policy: TrustPolicy;
  policyInvalid: boolean;
  wildcardEntries: { pattern: string; value: TrustPolicy[string] }[];
  sessionDenied: Map<string, boolean>;
  sessionAllowed: Map<string, boolean>;
  yolo: boolean;
  promptDelegatePresent: boolean;
  isSensitiveReadCall(tool: Tool, input: unknown): boolean;
  yoloBlockedAsDestructive(tool: Tool, input: unknown, ctx: Context): boolean;
}

export function explainPermissionTrace(
  state: PermissionExplainContext,
  tool: Tool,
  input: unknown,
  ctx: Context,
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
  ): void => {
    steps.push({ rule, matched, decision, source, detail });
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
  const entry = state.policy[tool.name] ?? namespaceEntry;
  const namespaceSource = namespaceEntry
    ? `wildcard entry matched (${Object.keys(state.policy).find((k) => k.includes('*') && matchGlob(k, tool.name))})`
    : 'no namespace match';

  // 2. Session soft deny
  const cacheKey = `${tool.name}::${subject ?? tool.name}`;
  if (state.sessionDenied.has(cacheKey)) {
    add(
      'session soft deny',
      true,
      'deny',
      'deny',
      'user pressed "no" earlier in this session — blocked until reload',
    );
    winnerIndex = steps.length - 1;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: {
        permission: 'deny',
        source: 'deny',
        reason: 'session soft deny (user pressed no)',
      },
    };
  }
  add(
    'session soft deny',
    false,
    'deny',
    'deny',
    'no session-level soft deny for this tool+subject',
  );

  // 3. Session soft allow (one-shot)
  if (state.sessionAllowed.has(cacheKey)) {
    add(
      'session soft allow',
      true,
      'auto',
      'trust',
      'user pressed "yes" in current session — one-shot auto-approve (consumed)',
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

  // 4. Trust deny
  if (entry?.deny && subject && matchesTrust(entry.deny, subject)) {
    add(
      'trust deny',
      true,
      'deny',
      'deny',
      `subject "${subject}" matched a deny pattern in trust file`,
    );
    winnerIndex = steps.length - 1;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: { permission: 'deny', source: 'deny', reason: 'matched deny pattern' },
    };
  }
  add(
    'trust deny',
    false,
    'deny',
    'deny',
    `no deny pattern matched (namespace: ${namespaceSource})`,
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

  // 6. Trust allow
  if (entry?.allow && subject && matchesTrust(entry.allow, subject)) {
    add(
      'trust allow',
      true,
      'auto',
      'trust',
      `subject "${subject}" matched an allow pattern in trust file`,
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
  if (entry?.auto) {
    add('trust auto', true, 'auto', 'trust', `trust file has auto: true for "${tool.name}"`);
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
    const isAgentState = isInsideAgentStateRoot(subject);
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

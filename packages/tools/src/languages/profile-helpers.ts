import type {
  CommandPlan,
  LanguageOperation,
  OperationPlanResult,
  ProfileContext,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 200_000;

export function processPlan(
  ctx: ProfileContext,
  operation: LanguageOperation,
  command: string,
  args: readonly string[],
  options: {
    parser: string;
    reason: string;
    timeoutMs?: number | undefined;
    mutating?: boolean | undefined;
    network?: boolean | undefined;
    executesProjectCode?: boolean | undefined;
  },
): CommandPlan {
  return {
    profileId: ctx.workspace.language,
    workspaceId: ctx.workspace.id,
    operation,
    kind: 'process',
    command,
    args: Object.freeze([...args]),
    cwd: ctx.workspace.root,
    env: Object.freeze({}),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    mutating: options.mutating ?? false,
    network: options.network ?? false,
    executesProjectCode: options.executesProjectCode ?? false,
    reason: options.reason,
    evidence: ctx.workspace.evidence,
    parser: options.parser,
  };
}

export function internalPlan(
  ctx: ProfileContext,
  operation: LanguageOperation,
  parser: string,
  reason: string,
): CommandPlan {
  return {
    profileId: ctx.workspace.language,
    workspaceId: ctx.workspace.id,
    operation,
    kind: 'internal',
    command: null,
    args: Object.freeze([]),
    cwd: ctx.workspace.root,
    env: Object.freeze({}),
    timeoutMs: 5_000,
    outputLimitBytes: 32_768,
    mutating: false,
    network: false,
    executesProjectCode: false,
    reason,
    evidence: ctx.workspace.evidence,
    parser,
  };
}

export function unavailable(
  ctx: ProfileContext,
  operation: LanguageOperation,
  reason: string,
): OperationPlanResult {
  return {
    status: 'unavailable',
    profileId: ctx.workspace.language,
    workspaceId: ctx.workspace.id,
    operation,
    reason,
  };
}

export function packageNames(ctx: ProfileContext): readonly string[] {
  return ctx.options.packages ?? [];
}

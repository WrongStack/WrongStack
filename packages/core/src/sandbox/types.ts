/**
 * Sandbox tier contract (plan 28 — docs/specs/sandboxed-execution-tiers-sdd.md).
 *
 * T1 scope: types + config resolution only. Enforcement lives in the exec
 * choke point (`wrap.ts`) and the backend implementations. The default config
 * (`mode: 'off'`) preserves current behavior exactly — hosts opt in.
 */

import type {
  SandboxBackendId,
  SandboxConfig,
  SandboxMode,
  SandboxTier,
} from '@wrongstack/contracts/types/sandbox';

export type { SandboxBackendId, SandboxConfig, SandboxMode, SandboxTier };

export const SANDBOX_MODES: readonly SandboxMode[] = ['off', 'enforced'];
export const SANDBOX_TIERS: readonly SandboxTier[] = [
  'read-only',
  'workspace-write',
  'full-access',
];
export const SANDBOX_BACKEND_IDS: readonly SandboxBackendId[] = [
  'policy-only',
  'container',
  'windows-native',
];

/** Frozen defaults: `mode: 'off'` means no behavioral change for any host. */
export const DEFAULT_SANDBOX_CONFIG: Readonly<SandboxConfig> = Object.freeze({
  mode: 'off',
  tier: 'read-only',
  writableRoots: [] as string[],
  backend: 'policy-only',
});

/** One exec-family call as seen by the choke point. */
export interface SandboxExecCall {
  readonly tool: string;
  /**
   * T7/T5.1: the PER-AGENT resolved config the choke point routed with —
   * backends must gate on this instead of re-reading the process-global
   * policy, so a tightening override can never fail-open (chimera HIGH,
   * 2026-10-04). Omitted by direct backend callers; those fall back to the
   * global policy.
   */
  readonly config?: SandboxConfig;
}

export type SandboxDecision =
  | { readonly outcome: 'allow' }
  | {
      readonly outcome: 'deny';
      readonly reason: string;
      readonly missing: ReadonlyArray<{
        readonly type: 'path' | 'network';
        readonly value: string;
      }>;
    };

export interface SandboxRouteRequest {
  /** Which exec-family tool the input came from (`bash` = shell form, `exec`/`pwsh` = argv form). */
  tool: string;
  kind: 'shell' | 'argv';
  command?: string;
  argv?: string[];
  cwd?: string | undefined;
}

export interface SandboxRoute {
  command?: string;
  argv?: string[];
}

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  enforceExec(call: SandboxExecCall): Promise<SandboxDecision>;
  /**
   * T4 spawn-routing: rewrite a bash/exec input into the backend's contained
   * form (`docker run …`). Return `undefined` for `full-access`, unroutable
   * shapes, or backends without routing (policy-only).
   */
  routeExec?(request: SandboxRouteRequest, config: SandboxConfig): SandboxRoute | undefined;
  /**
   * T5.1: optional spawn-helper hook. Runs after `routeExec` produced a
   * route and may return a transformed route (e.g. the payload wrapped in a
   * restricted-token launcher); `void`/`undefined` keeps the original route.
   * The helper closes over whatever plan it needs (ACL grants, integrity
   * policy) — the choke point only routes.
   */
  applyHelper?(route: SandboxRoute): Promise<SandboxRoute | void>;
}

/** The deny arm of SandboxDecision — what denials, audit events, and expansion requests carry. */
export type SandboxDenyDecision = Extract<SandboxDecision, { outcome: 'deny' }>;

/** Thrown by the choke point when a backend denies an exec-family call. */
export class SandboxDeniedError extends Error {
  readonly kind = 'sandbox_denied';
  readonly tool: string;
  readonly decision: Extract<SandboxDecision, { outcome: 'deny' }>;

  constructor(tool: string, decision: Extract<SandboxDecision, { outcome: 'deny' }>) {
    super(`sandbox_denied: ${tool}: ${decision.reason}`);
    this.name = 'SandboxDeniedError';
    this.tool = tool;
    this.decision = decision;
  }
}

function pick<T extends string>(
  value: T | undefined,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) {
    throw new TypeError(
      `tools.sandbox.${field} must be one of ${allowed.join(', ')} (got ${String(value)})`,
    );
  }
  return value;
}

/** Merge a partial config over the defaults, validating every enum field. */
export function resolveSandboxConfig(raw?: Partial<SandboxConfig> | undefined): SandboxConfig {
  const roots = raw?.writableRoots ?? DEFAULT_SANDBOX_CONFIG.writableRoots;
  if (!Array.isArray(roots) || roots.some((r) => typeof r !== 'string')) {
    throw new TypeError('tools.sandbox.writableRoots must be an array of strings');
  }
  return {
    mode: pick(raw?.mode, SANDBOX_MODES, 'mode', DEFAULT_SANDBOX_CONFIG.mode),
    tier: pick(raw?.tier, SANDBOX_TIERS, 'tier', DEFAULT_SANDBOX_CONFIG.tier),
    writableRoots: [...roots],
    backend: pick(raw?.backend, SANDBOX_BACKEND_IDS, 'backend', DEFAULT_SANDBOX_CONFIG.backend),
    image: typeof raw?.image === 'string' && raw.image.trim() !== '' ? raw.image.trim() : undefined,
  };
}

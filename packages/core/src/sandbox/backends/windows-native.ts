import { getResolvedSandboxConfig } from '../manager.js';
import type {
  SandboxBackend,
  SandboxConfig,
  SandboxDecision,
  SandboxDenyDecision,
  SandboxExecCall,
  SandboxRoute,
  SandboxRouteRequest,
} from '../types.js';
import { defaultWindowsHelperRunner, type SandboxHelperRunner } from '../windows-helper.js';

/**
 * T5 windows-native backend (plan 28): enforces via Windows ACL state plus a
 * restricted-token spawn helper. Mirrors T4's input-rewrite model — the
 * backend never executes anything; `wrap.ts` applies the returned route.
 *
 * Honest v1 boundary (SDD "Windows-native enforcement design (T5)"): minting
 * a true restricted token requires the native sandbox helper (T5.1). Without
 * a configured helper the backend FAILS CLOSED with an actionable reason
 * instead of degrading to same-user host execution (deny/grant ACEs for the
 * same user are a no-op — that would be a half-truth sandbox). The pure
 * builders (ACL plan + route) are always runnable in unit tests.
 */

const HELPER_HINT =
  'windows-native tier requires the WrongStack sandbox helper (plan 28 T5.1); it is not configured on this host';

/** The sandbox identity the helper provisions; substituted at helper time. */
const SANDBOX_IDENTITY = 'WrongStackSandbox';

export interface WindowsAclPlan {
  /** icacls grant argv per writable root (`workspace-write` only). */
  grants: string[][];
  /** Writable roots to mark Low integrity so the restricted token may write them. */
  lowIntegrityDirs: string[];
}

/**
 * Pure ACL-plan builder — always runnable in unit tests. `read-only` emits
 * no grants (the sandbox token gets no writable grant anywhere; read access
 * rides mandatory integrity policy), `full-access` never routes.
 */
export function buildWindowsAclPlan(config: SandboxConfig): WindowsAclPlan {
  if (config.tier !== 'workspace-write') return { grants: [], lowIntegrityDirs: [] };
  const roots = config.writableRoots.map((root) => root.trim()).filter(Boolean);
  return {
    grants: roots.map((root) => ['icacls', root, '/grant', `${SANDBOX_IDENTITY}:(OI)(CI)M`]),
    lowIntegrityDirs: [...roots],
  };
}

/** cmd.exe double-quote escape — the documented literal form inside `"…"`. */
function cmdDoubleQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Pure route builder. `full-access` never routes; bash (shell form) routes as
 * a `cmd.exe /d /s /c` line, exec (argv form) as a cmd argv; other tool names
 * are unroutable and stay host-executed under the standard approval path.
 */
export function buildWindowsRoute(
  request: SandboxRouteRequest,
  config: SandboxConfig,
): SandboxRoute | undefined {
  if (config.tier === 'full-access') return undefined;
  if (request.kind === 'argv' && request.argv !== undefined) {
    return { argv: ['cmd.exe', '/d', '/s', '/c', ...request.argv] };
  }
  if (request.kind === 'shell' && request.command !== undefined) {
    return { command: `cmd.exe /d /s /c ${cmdDoubleQuote(request.command)}` };
  }
  return undefined;
}

function deny(reason: string, missing: SandboxDenyDecision['missing']): SandboxDenyDecision {
  return { outcome: 'deny', reason, missing };
}

export interface WindowsNativeBackendOptions {
  /** Test/integration seam: overrides the platform check. */
  platform?: NodeJS.Platform;
  /**
   * T5.1: the sandbox helper runner — transforms the built route into the
   * restricted-token launcher form. Default singleton wires
   * `defaultWindowsHelperRunner()` on win32; unconfigured ⇒ fail closed.
   */
  helperRunner?: SandboxHelperRunner;
}

export function createWindowsNativeSandboxBackend(
  options: WindowsNativeBackendOptions = {},
): SandboxBackend {
  const applyHelper = options.helperRunner;
  return {
    id: 'windows-native',

    async enforceExec(call: SandboxExecCall): Promise<SandboxDecision> {
      // Per-agent config wins (T7 tightening overrides); global policy fallback
      // for direct backend callers (chimera HIGH fix, 2026-10-04).
      const config = call.config ?? getResolvedSandboxConfig();
      if (config.tier === 'full-access') return { outcome: 'allow' };
      if ((options.platform ?? process.platform) !== 'win32') {
        return deny('windows-native sandbox requires Windows', [
          { type: 'path', value: 'process.platform' },
        ]);
      }
      if (!applyHelper) {
        return deny(HELPER_HINT, [{ type: 'path', value: 'sandbox helper (plan 28 T5.1)' }]);
      }
      return { outcome: 'allow' };
    },

    routeExec(request: SandboxRouteRequest, config: SandboxConfig): SandboxRoute | undefined {
      return buildWindowsRoute(request, config);
    },

    ...(applyHelper
      ? {
          applyHelper: (
            route: SandboxRoute,
            config?: SandboxConfig,
          ): Promise<SandboxRoute | void> => applyHelper(route, config),
        }
      : {}),
  };
}

/** Production singleton: on win32 the PowerShell safer-layer helper is the default. */
export const windowsNativeSandboxBackend = createWindowsNativeSandboxBackend(
  process.platform === 'win32'
    ? { platform: process.platform, helperRunner: defaultWindowsHelperRunner() }
    : { platform: process.platform },
);

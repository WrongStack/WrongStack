/**
 * Tool gateway — the one execution core behind every surface that lets an
 * EXTERNAL caller drive WrongStack's built-in tools without an agent loop.
 *
 * Two adapters sit on top of it today:
 * - `wstack mcp serve`  — MCP over stdio/HTTP (`mcp-serve.ts`)
 * - `wstack tools run`  — one call per process (`subcommands/handlers/tools-cli.ts`)
 *
 * Both used to need the same subtle decisions — which tools are exposed, which
 * permission policy applies, whether file tools are confined to the project
 * root, and that every call gets a fresh Context. Keeping those in one place is
 * the point: a second hand-written copy is how a surface quietly ends up with a
 * wider default than the other.
 */

import type {
  Config,
  PermissionPolicy,
  Provider,
  SessionWriter,
  TokenCounter,
  Tool,
  ToolSettlement,
  ToolsConfig,
} from '@wrongstack/contracts/types';
import { normalizeTokenSavingTier } from '@wrongstack/contracts/types';
import { Context } from '@wrongstack/core/agent';
import { ToolExecutor } from '@wrongstack/core/execution';
import { ToolRegistry } from '@wrongstack/core/registry';
import {
  AutoApprovePermissionPolicy,
  DefaultSecretScrubber,
  ToolCapabilities,
} from '@wrongstack/core/security';
import { toErrorMessage } from '@wrongstack/core/utils';
import { systemSessionId } from '@wrongstack/primitives';
import { wireKanbanPorts } from '@wrongstack/runtime';
import { BROWSER_TOOL_NAMES } from '@wrongstack/tools/browser';
import { runStartupIndex, shutdownCodebaseIndexHost } from '@wrongstack/tools/codebase-index';
import { registerBuiltinToolTier } from '@wrongstack/tools/tool-tier';

/**
 * The registry a gateway serves: the subcommand's pre-populated one when the
 * dispatcher built it, else a fresh built-in tier. Also binds the Kanban ports
 * the `kanban` tool resolves at call time.
 */
export function resolveGatewayRegistry(
  existing: ToolRegistry | undefined,
  config: Pick<Config, 'features'>,
): ToolRegistry {
  wireKanbanPorts();
  if (existing) return existing;
  const registry = new ToolRegistry();
  registerBuiltinToolTier({
    registry,
    tier: normalizeTokenSavingTier(config.features.tokenSavingMode),
  });
  return registry;
}

/**
 * The gateway's default allowlist: the same read-only pair
 * `AutoApprovePermissionPolicy` uses when constructed without one. Spelled out
 * here because `--allow` extends it — the granted mode must start from exactly
 * the set the safe mode exposes, not from a second copy that can drift.
 */
const READ_ONLY_CAPABILITIES: readonly string[] = [
  ToolCapabilities.FS_READ,
  ToolCapabilities.NET_OUTBOUND,
];

/**
 * Parse `--allow fs.write,shell.exec` into capability ids. Every entry must be
 * a known capability — a typo silently granting nothing would read as "the
 * tool is broken", and a typo that matched something unintended would widen
 * the grant. A bare `--allow` (no list) is an error, never "allow everything".
 */
export function parseCapabilityGrants(raw: string | boolean | undefined): string[] {
  if (raw === undefined || raw === false) return [];
  if (raw === true || raw.trim() === '') {
    throw new Error(
      `--allow needs a comma-separated capability list, e.g. --allow fs.write (known: ${knownCapabilities()})`,
    );
  }
  const known = new Set<string>(Object.values(ToolCapabilities));
  const grants = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = grants.filter((g) => !known.has(g));
  if (unknown.length > 0) {
    throw new Error(
      `--allow: unknown capability ${unknown.map((u) => `"${u}"`).join(', ')} (known: ${knownCapabilities()})`,
    );
  }
  return [...new Set(grants)];
}

function knownCapabilities(): string {
  return Object.values(ToolCapabilities).join(', ');
}

/**
 * `--yolo` for the gateway: widen the CAPABILITY allowlist, keep every guard.
 *
 * This replaced an `AllowAllPermissionPolicy extends AutoApprovePermissionPolicy`
 * whose `evaluate()` returned `{ permission: 'auto' }` unconditionally. That
 * override skipped the whole base implementation — the sensitive-read denial,
 * the leader deny rules, the destructive-command classifier, the agent-state
 * write guard, and `LOCKED_DESTRUCTIVE_KINDS`. It was the only place in the
 * codebase where `agent-state` and `credential-bind` could be un-gated, so a
 * third-party MCP client could have written `hooks` into config.json (boot-time
 * RCE) or `auto: true` into trust.json.
 *
 * It did not actually get there — but only by accident, and the accident is the
 * reason this is a rewrite rather than a patch. The override returned
 * `source: 'default'` where the base class returns `source: 'yolo'`, so
 * `ToolExecutor.capabilityDowngraded` re-armed and forced `confirm`; the gateway
 * has no confirmAwaiter, so the call hard-errored. Changing that one string
 * literal to `'yolo'` — which reads as a trivial consistency cleanup — would
 * have made the bypass live. Safety must not rest on a string nobody knows is
 * load-bearing.
 *
 * Granting every capability is what `--yolo` actually means, and it is what
 * lets `ToolExecutor` trust an `auto` instead of downgrading it (see the
 * `dangerousNotAllowed` reasoning in `auto-approve-policy.ts`). The destructive
 * classifier is deliberately NOT relaxed: `yoloConfirmKinds` is left at its
 * default, which gates every destructive kind. Destructive calls therefore
 * still require a confirmation this surface cannot answer, exactly as before —
 * this change removes a latent bypass without widening anything.
 */
export function yoloServePolicy(yoloPlus?: () => boolean): AutoApprovePermissionPolicy {
  return new AutoApprovePermissionPolicy(
    Object.values(ToolCapabilities),
    yoloPlus ? { yoloPlus } : undefined,
  );
}

/**
 * Whether the file tools are confined to the project root for the gateway.
 *
 * The gateway is the one surface where the file tools are driven by a REMOTE
 * caller, so an unset config must inherit containment rather than invert it —
 * an unset value here previously became `false`, which short-circuited
 * `ensureInsideRoot` and let `tools/call read` return `~/.ssh/id_rsa`.
 *
 * This lives in one exported function rather than as a literal repeated at each
 * call site so the invariant is testable and a third call site cannot quietly
 * reintroduce the wrong default. Only a trusted user config can opt out:
 * `tools.restrictToProjectRoot` is on the in-project denylist, so a
 * checked-out repository cannot reach it.
 */
export function resolveServeFsRestriction(config: {
  tools?: { restrictToProjectRoot?: boolean | undefined } | undefined;
}): boolean {
  return config.tools?.restrictToProjectRoot ?? true;
}

/** Event owner for calls that arrive through the gateway rather than a session. */
const GATEWAY_SESSION_ID = systemSessionId('tool-gateway');

/** Minimal run context — tools read cwd/projectRoot/signal; provider/session are stubs. */
export function makeServeContext(
  cwd: string,
  projectRoot: string,
  signal: AbortSignal,
  restrictFsToRoot = true,
): Context {
  const provider = {
    id: 'mcp-serve',
    capabilities: { maxContext: 0 },
    complete: async () => {
      throw new Error('no model provider in tool-gateway mode');
    },
    stream: () => {
      throw new Error('no model provider in tool-gateway mode');
    },
  } as never as Provider;
  // Tools stamp file and agent events with `ctx.eventSessionId()`, which
  // refuses an id-less session — every `read` failed with "Session id is
  // required for agent event emission". There is no user session here, so the
  // events name the gateway as a `system:` owner a UI can filter out.
  const session = {
    id: GATEWAY_SESSION_ID,
    append: async () => {},
  } as never as SessionWriter;
  const tokenCounter = {
    account: () => {},
    total: () => ({ input: 0, output: 0 }),
    estimateCost: () => ({ total: 0 }),
  } as never as TokenCounter;
  return new Context({
    systemPrompt: [],
    provider,
    session,
    signal,
    tokenCounter,
    cwd,
    projectRoot,
    allowOutsideProjectRoot: !restrictFsToRoot,
    model: 'mcp-serve',
    tools: [],
  });
}

/**
 * Compute the set of tools a gateway exposes: a tool is included only if it
 * passes the whitelist (when set) AND the permission policy returns `auto`.
 * With `AutoApprovePermissionPolicy` this withholds shell/write/edit and
 * dangerous-capability tools; with the `--yolo` policy everything passes.
 */
export async function selectExposedTools(
  registry: ToolRegistry,
  ctx: Context,
  policy: PermissionPolicy,
  whitelist: Set<string> | null,
): Promise<Tool[]> {
  const allowed: Tool[] = [];
  for (const tool of registry.list()) {
    if (whitelist && !whitelist.has(tool.name)) continue;
    const decision = await policy.evaluate(tool, {}, ctx);
    if (decision.permission === 'auto') allowed.push(tool);
  }
  return allowed;
}

/**
 * Built-in tools that only make sense inside an agent session, withheld from
 * one-shot callers (`wstack tools run`).
 *
 * The gateway Context has no model, no user and no session, so these either
 * fail on every call or — worse — answer as if a session were there:
 * - `clarify` falls back to the form's recommended answer when no host can ask
 *   a human, so an external caller would read a fabricated "user answer".
 * - `tool_use` / `tool_script` / `tool_search` work over the session's tool
 *   catalog, which is empty here, and nested execution is not wired.
 * - `present_artifact`, `todo`, `plan` write session-owned state.
 *
 * A name that stops existing is caught by `tools-cli.test.ts`, so a rename
 * cannot silently re-expose a tool under its new name.
 */
const SESSION_BOUND_TOOL_NAMES: ReadonlySet<string> = new Set([
  'clarify',
  'tool_use',
  'tool_script',
  'tool_search',
  'present_artifact',
  'todo',
  'plan',
]);

/**
 * Tools whose state lives in the serving PROCESS. The browser suite keeps its
 * sessions in an in-process manager: `browser_open` returns a `sessionId` that
 * is meaningless to the next `wstack tools run`, which is a new process. Over
 * a long-lived `mcp serve` they work; one-shot they would only launch and
 * abandon browsers.
 */
const PROCESS_BOUND_TOOL_NAMES: ReadonlySet<string> = new Set(BROWSER_TOOL_NAMES);

/**
 * Tools that answer from the persisted codebase index rather than from the
 * files on disk (`codebase-read-symbol` / `codebase-skeleton` parse the file
 * directly and are always current).
 *
 * The project index daemon only watches the disk while a client that asked
 * for it (`watchExternal`) is connected. A one-shot call never stays connected
 * long enough, so an external agent that edited files and then asked
 * `codebase-search` got the index as it was before its own edits — measured:
 * the first catch-up after a quiet hour found 13 changed files. Pinned by
 * `tools-cli-index-freshness.test.ts` against the registry, so a rename fails
 * loudly instead of silently skipping the refresh.
 */
const INDEX_READING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'codebase-search',
  'codebase-context',
  'codebase-impact-analysis',
  'codebase-incoming-calls',
  'codebase-outgoing-calls',
  'codebase-repo-map',
  'codebase-stats',
]);

/** A remote-agent server starts at most one index catch-up per this window. */
const REMOTE_CATCH_UP_INTERVAL_MS = 1_000;

/** Whether a one-shot call to this tool first catches the index up with the disk. */
export function readsCodebaseIndex(name: string): boolean {
  return INDEX_READING_TOOL_NAMES.has(name);
}

/** Why a one-shot caller cannot use this tool, or undefined when it can. */
function oneShotWithholdReason(name: string): 'session' | 'process' | undefined {
  if (SESSION_BOUND_TOOL_NAMES.has(name)) return 'session';
  if (PROCESS_BOUND_TOOL_NAMES.has(name)) return 'process';
  return undefined;
}

/**
 * Why `name` is not callable through `gateway`, in words a caller can act on —
 * one text for every surface (`wstack tools run`, `wstack tools serve`), since
 * the flags it names are the same on both.
 */
export function withheldReason(gateway: ToolGateway, registry: ToolRegistry, name: string): string {
  const bound = gateway.withheldBy(name);
  if (bound === 'session') {
    return `Tool "${name}" only works inside an agent session and is not exposed here.`;
  }
  if (bound === 'process') {
    return `Tool "${name}" keeps its state in a long-lived process; use \`wstack mcp serve\` or \`wstack tools serve\` for it.`;
  }
  const tool = registry.get(name);
  if (!tool) return `Unknown tool "${name}". List the exposed tools first.`;
  const missing = (tool.capabilities ?? []).filter((c) => !gateway.capabilities.includes(c));
  return gateway.mode === 'yolo' || missing.length === 0
    ? `Tool "${name}" is withheld by policy.`
    : `Tool "${name}" is withheld: it needs ${missing.join(', ')}. ` +
        `Pass --allow ${missing.join(',')} (or --yolo for every capability); deleting outside ` +
        'the project, git-history and download-and-run commands stay refused.';
}

export interface ToolGatewayOptions {
  registry: ToolRegistry;
  /** Only the `tools.*` knobs the gateway reads. */
  config: {
    tools?:
      | Partial<
          Pick<ToolsConfig, 'restrictToProjectRoot' | 'maxToolTimeoutMs' | 'kanbanGovernance'>
        >
      | undefined;
  };
  cwd: string;
  projectRoot: string;
  /** Grant every capability; the subagent locks still refuse. */
  yolo: boolean;
  /**
   * Under `yolo`: whether the user's YOLO+ is on right now (destructive kinds
   * then pass; the locked ones never do). An in-process worker gateway reads
   * the live config; the CLI surfaces leave it unset.
   */
  yoloPlus?: (() => boolean) | undefined;
  /**
   * Capabilities granted on top of the read-only default (`--allow`), each
   * validated by {@link parseCapabilityGrants}. Ignored under `yolo`.
   */
  allow?: readonly string[] | undefined;
  /** Restrict to these names; null exposes everything the policy allows. */
  whitelist: Set<string> | null;
  /**
   * Each call is its own process (`wstack tools run`): also withhold tools
   * whose state lives in a session or in the serving process
   * ({@link oneShotWithholdReason}).
   */
  oneShot?: boolean | undefined;
  /**
   * A long-lived server whose caller edits the tree with its own tools
   * (`wstack tools serve`, called by an external agent): withhold the
   * session-bound tools (process-bound ones work in a long-lived process), and
   * catch the index up before EVERY index-reading call — the caller's edits
   * are invisible to WrongStack, so "once per process" would go stale.
   * Concurrent calls share one catch-up; at most one starts per second.
   */
  remoteAgent?: boolean | undefined;
  /**
   * One-shot / remote-agent: bring the index up to date with the disk before an
   * index-reading call ({@link readsCodebaseIndex}) — once per process, and
   * again after any mutating call. Incremental by mtime (~0.3s on an
   * unchanged 11k-file repo). Defaults to the real catch-up; injectable for tests.
   */
  catchUpIndex?: ((projectRoot: string, signal: AbortSignal) => Promise<void>) | undefined;
  /** Non-fatal problems (a failed index catch-up) for the caller to surface. */
  onWarning?: ((message: string) => void) | undefined;
}

export type ToolGatewayCallResult =
  | {
      kind: 'result';
      content: string;
      isError: boolean;
      settlement: ToolSettlement;
      durationMs: number;
    }
  /** Not in the exposed set — withheld by policy/whitelist, or unknown. */
  | { kind: 'not_exposed' }
  /** The call needs an interactive confirmation the gateway cannot give. */
  | { kind: 'confirm_required' };

export interface ToolGateway {
  /** `safe` = read-only default, `granted` = default plus `--allow`, `yolo` = everything. */
  readonly mode: 'safe' | 'granted' | 'yolo';
  /** The capability allowlist the policy evaluates against. */
  readonly capabilities: readonly string[];
  /** The root the file tools are confined to; per-call `cwd` must lie inside it. */
  readonly projectRoot: string;
  /** Exposed tools, in registry order. `list` and `call` always agree. */
  readonly tools: readonly Tool[];
  get(name: string): Tool | undefined;
  /** Whether this surface withholds `name` for living in a session / the serving process. */
  withheldBy(name: string): 'session' | 'process' | undefined;
  /**
   * `options.cwd`: this call's working directory (relative paths, shell
   * commands). The caller validates it against {@link projectRoot}; the
   * file tools stay confined to the root either way.
   */
  call(
    name: string,
    input: Record<string, unknown>,
    options?: { cwd?: string | undefined },
  ): Promise<ToolGatewayCallResult>;
  /** Abort in-flight calls and disconnect from the project daemons. */
  close(): Promise<void>;
}

export async function createToolGateway(options: ToolGatewayOptions): Promise<ToolGateway> {
  const { registry, config, cwd, projectRoot } = options;
  const restrictFsToRoot = resolveServeFsRestriction(config);
  const controller = new AbortController();
  const grants = options.yolo ? [] : [...new Set(options.allow ?? [])];
  const mode: ToolGateway['mode'] = options.yolo ? 'yolo' : grants.length > 0 ? 'granted' : 'safe';
  const capabilities: readonly string[] = options.yolo
    ? Object.values(ToolCapabilities)
    : [...new Set([...READ_ONLY_CAPABILITIES, ...grants])];
  const permissionPolicy: PermissionPolicy = options.yolo
    ? yoloServePolicy(options.yoloPlus)
    : new AutoApprovePermissionPolicy(capabilities);
  const executor = new ToolExecutor(registry, {
    permissionPolicy,
    secretScrubber: new DefaultSecretScrubber(),
    maxToolTimeoutMs: config.tools?.maxToolTimeoutMs ?? 300_000,
    perIterationOutputCapBytes: 1_000_000,
    // Kanban tracks work; it does not gate it. Off unless the operator opts in.
    // See wiring/pipeline.ts for why all four hosts must agree.
    requireKanbanGovernance: config.tools?.kanbanGovernance ?? false,
  });

  // This context is only used while deciding which tools to expose. Tool calls
  // must receive a fresh Context below: Context carries mutable per-run state
  // such as workingDir and file tracking, which must never bleed between
  // callers or concurrent requests.
  const selectionCtx = makeServeContext(cwd, projectRoot, controller.signal, restrictFsToRoot);
  // Pre-compute the exposed set so list and call agree, and so a withheld tool
  // can never be invoked even if a caller guesses its name.
  const selected = await selectExposedTools(
    registry,
    selectionCtx,
    permissionPolicy,
    options.whitelist,
  );
  const withheld = (name: string): boolean => {
    const reason = oneShotWithholdReason(name);
    if (options.oneShot) return reason !== undefined;
    if (options.remoteAgent) return reason === 'session';
    return false;
  };
  const tools = selected.filter((t) => !withheld(t.name));
  const byName = new Map(tools.map((t) => [t.name, t]));

  const catchUpIndex =
    options.catchUpIndex ??
    (async (root: string, signal: AbortSignal) => {
      await runStartupIndex({ projectRoot: root, signal });
    });
  // One-shot callers edit the tree between calls without WrongStack seeing it;
  // `indexCurrent` is reset by every mutating call made through this gateway.
  let indexCurrent = false;
  let lastCatchUpAt = 0;
  let catchUpInFlight: Promise<void> | undefined;
  const runCatchUp = async (): Promise<void> => {
    try {
      await catchUpIndex(projectRoot, controller.signal);
    } catch (err) {
      // Answer from the index as it is rather than not at all; the query
      // itself reports a daemon that is truly unavailable.
      options.onWarning?.(`codebase index catch-up failed: ${toErrorMessage(err)}`);
    } finally {
      indexCurrent = true;
      lastCatchUpAt = Date.now();
      catchUpInFlight = undefined;
    }
  };
  const indexNeedsCatchUp = (): boolean => {
    if (options.oneShot) return !indexCurrent;
    if (options.remoteAgent) return Date.now() - lastCatchUpAt >= REMOTE_CATCH_UP_INTERVAL_MS;
    return false;
  };

  let counter = 0;
  return {
    mode,
    capabilities,
    projectRoot,
    tools,
    get: (name) => byName.get(name),
    withheldBy: (name) => (withheld(name) ? oneShotWithholdReason(name) : undefined),
    async call(name, input, callOptions) {
      const tool = byName.get(name);
      if (!tool) return { kind: 'not_exposed' };
      if (readsCodebaseIndex(name) && (catchUpInFlight || indexNeedsCatchUp())) {
        catchUpInFlight ??= runCatchUp();
        await catchUpInFlight;
      }
      if (tool.mutating) indexCurrent = false;
      const use = { type: 'tool_use' as const, id: `srv_${++counter}`, name, input };
      // `sequential` applies only within this one-item batch. It does not
      // serialize requests from other callers, while the fresh Context
      // prevents their mutable run state from being shared.
      const requestCtx = makeServeContext(
        callOptions?.cwd ?? cwd,
        projectRoot,
        controller.signal,
        restrictFsToRoot,
      );
      const batch = await executor.executeBatch([use], requestCtx, 'sequential');
      const output = batch.outputs[0];
      const result = output?.result;
      if (!output || !result || result.type === 'tool_confirm_pending') {
        return { kind: 'confirm_required' };
      }
      const isError = Boolean(result.is_error);
      return {
        kind: 'result',
        content: result.content,
        isError,
        settlement: output.settlement ?? (isError ? 'failed' : 'completed'),
        durationMs: output.durationMs,
      };
    },
    async close() {
      controller.abort();
      // The codebase-* tools hold an IPC connection to the project index
      // daemon (the daemon itself keeps running for other clients). Left open,
      // every one-shot call waited out the 500ms forced-exit grace and printed
      // an `exit.forced` warning on stderr.
      await shutdownCodebaseIndexHost();
    },
  };
}

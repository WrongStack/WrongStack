import { toErrorMessage } from '@wrongstack/core/utils';
import { ACPSession } from '../client/acp-session.js';
import { canonicalAcpAgentId, REGISTRY_ID_ALIASES } from '../registry/agent-ids.js';
import { acpCommandOnPath } from '../registry/agent-on-path.js';
import { findAgentDescriptor } from '../registry/agents.catalog.js';
import type { AgentCapabilities } from '../types/acp-v1.js';
import type { ACPSubagentRunnerOptions } from './acp-subagent-runner-options.js';

export { REGISTRY_ID_ALIASES } from '../registry/agent-ids.js';

/**
 * Static catalog of agent ids → spawn options.
 *
 * The CLI and the host's `buildACPRunner` look up entries by id. The
 * canonical, multi-source catalog is `packages/acp/src/registry/agents.catalog.ts`
 * (the 12-entry static catalog introduced in commit 4ad287b4). This
 * map stays for backward compatibility with existing call sites that
 * import it directly; new code should prefer the registry.
 */
export const ACP_AGENT_COMMANDS: Record<string, ACPSubagentRunnerOptions> = {
  cline: {
    command: 'npx',
    args: ['-y', '@agentify/cline'],
    role: 'cline',
  },
  'gemini-cli': {
    command: 'gemini',
    role: 'gemini-cli',
  },
  copilot: {
    command: 'gh',
    args: ['copilot', 'agent'],
    role: 'copilot',
  },
  openhands: {
    command: 'openhands',
    role: 'openhands',
  },
  goose: {
    command: 'goose',
    role: 'goose',
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Shared command resolution + single-task run + handshake probe
//
// These are the building blocks both the `wstack acp` CLI handler and the
// `/acp` slash command consume, so the two surfaces stay in lock-step.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Per-agent ACP invocation overrides, sourced from the user's
 * active profile config (`~/.wrongstack/profiles/<name>/config.json`,
 * `config.acp.agents`). Lets a user point an
 * agent id at the correct ACP entry — e.g. the Zed Claude-Code adapter —
 * without a code change. NEVER honoured from in-project config (it is an
 * arbitrary-command exec surface); see `config-loader.ts`.
 */
export type AcpAgentCommandOverrides = Record<
  string,
  { command: string; args?: string[]; env?: Record<string, string> }
>;

/** A synced-registry catalog keyed by registry id (from `fetchAcpRegistry`). */
export type AcpLiveCatalog = Record<
  string,
  {
    command: string;
    args?: readonly string[];
    env?: Record<string, string>;
    quarantineReason?: string;
  }
>;

/**
 * Resolve an agent id to its spawn command. Precedence:
 *   1. user override for the requested id or its catalog/registry equivalent
 *   2. installed local ACP entry, when a curated invocation is available
 *   3. live synced registry, including pinned package versions
 *   4. bundled offline catalog and legacy launcher map
 */
export function resolveAcpAgentCommand(
  id: string,
  overrides?: AcpAgentCommandOverrides,
  live?: AcpLiveCatalog,
): ACPSubagentRunnerOptions | null {
  const canonical = canonicalAcpAgentId(id);
  const registry = Object.hasOwn(REGISTRY_ID_ALIASES, canonical)
    ? REGISTRY_ID_ALIASES[canonical]!
    : canonical;
  const keys = [...new Set([id, canonical, registry])];
  if (canonical === 'opencode' && !keys.includes('opencode-v2')) keys.push('opencode-v2');
  const lookup = (catalog: AcpLiveCatalog | undefined) =>
    keys
      .filter((key) => catalog && Object.hasOwn(catalog, key))
      .map((key) => catalog?.[key])
      .find((entry) => typeof entry?.command === 'string' && entry.command.length > 0);
  const bundled = findAgentDescriptor(canonical)?.acp;
  const liveEntry = lookup(live);
  const override = lookup(overrides);
  const registryEntry = live && Object.hasOwn(live, registry) ? live[registry] : undefined;
  if (!override && (liveEntry?.quarantineReason || registryEntry?.quarantineReason)) return null;
  const installed =
    bundled &&
    bundled.command !== 'npx' &&
    bundled.command !== 'uvx' &&
    (!liveEntry || acpCommandOnPath(bundled.command));
  const launch = override ?? (installed ? bundled : (liveEntry ?? bundled));
  if (launch) {
    return {
      command: launch.command,
      args: [...(launch.args ?? [])],
      ...(launch.env ? { env: launch.env } : {}),
      role: id,
    };
  }
  const fromMap = Object.hasOwn(ACP_AGENT_COMMANDS, id) ? ACP_AGENT_COMMANDS[id] : undefined;
  if (fromMap) return fromMap;
  return null;
}

export interface AcpProbeResult {
  id: string;
  ok: boolean;
  ms: number;
  agentInfo?: { name: string; title?: string | undefined; version: string } | undefined;
  capabilities?: AgentCapabilities | undefined;
  steering?: boolean | undefined;
  error?: string | undefined;
}

/**
 * Empirically test whether an agent actually speaks ACP on this machine:
 * spawn it, run the `initialize` handshake, and close. `ok: true` means the
 * agent answered `initialize` within `timeoutMs` (default 8s) — the truth,
 * regardless of what the static catalog guesses. A bare CLI that drops into
 * an interactive prompt fails here (init times out) instead of hanging a
 * real turn.
 */
export async function probeAcpAgent(
  idOrCmd: string | ACPSubagentRunnerOptions,
  opts?: {
    timeoutMs?: number | undefined;
    projectRoot?: string | undefined;
    overrides?: AcpAgentCommandOverrides | undefined;
    live?: AcpLiveCatalog | undefined;
  },
): Promise<AcpProbeResult> {
  const id = typeof idOrCmd === 'string' ? idOrCmd : (idOrCmd.role ?? idOrCmd.command);
  const cmd =
    typeof idOrCmd === 'string'
      ? resolveAcpAgentCommand(idOrCmd, opts?.overrides, opts?.live)
      : idOrCmd;
  if (!cmd) return { id, ok: false, ms: 0, error: 'unknown agent' };

  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const projectRoot = opts?.projectRoot ?? process.cwd();
  const startedAt = Date.now();
  let session: ACPSession | null = null;
  try {
    session = await ACPSession.start({
      command: cmd.command,
      ...(cmd.args !== undefined ? { args: cmd.args } : {}),
      ...(cmd.env !== undefined ? { env: cmd.env } : {}),
      role: cmd.role ?? id,
      cwd: projectRoot,
      projectRoot,
      // Bounds the `initialize` request: a CLI that spawns but never answers
      // the handshake fails after this instead of blocking.
      timeoutMs,
    });
    const info = session.getAgentInfo();
    return {
      id,
      ok: true,
      ms: Date.now() - startedAt,
      ...(info ? { agentInfo: info } : {}),
      capabilities: session.getCapabilities(),
      steering: session.canSteer(),
    };
  } catch (err) {
    return {
      id,
      ok: false,
      ms: Date.now() - startedAt,
      error: toErrorMessage(err),
    };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // best-effort
      }
    }
  }
}

export interface ProbeAcpAgentsOptions {
  agentIds: string[];
  resolveCmd: (id: string) => ACPSubagentRunnerOptions | null;
  projectRoot?: string | undefined;
  /** Max agents probed at once. Default 4. Keeps concurrent first-run `npx`
   *  downloads from starving local agents' stdout past their timeout. */
  concurrency?: number | undefined;
  /** Per-agent handshake timeout for LOCAL binary commands. Default 20s. */
  timeoutMs?: number | undefined;
  /** Per-agent timeout for `npx`/`uvx` commands (first run downloads the
   *  package, which is slow). Default 90s. */
  packageTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((id: string, result: AcpProbeResult) => void) | undefined;
}

/**
 * Probe many agents with BOUNDED concurrency. Unbounded `Promise.all` over the
 * full set spawns every agent at once — and a few concurrent `npx` downloads
 * peg the machine hard enough that even already-installed local agents miss
 * their handshake window. Bounding the fan-out (and giving npx/uvx a longer
 * timeout) is what makes a mixed install probe reliably.
 */
export async function probeAcpAgents(opts: ProbeAcpAgentsOptions): Promise<AcpProbeResult[]> {
  const localTimeout = opts.timeoutMs ?? 20_000;
  const pkgTimeout = opts.packageTimeoutMs ?? 90_000;
  const ids = opts.agentIds;
  const byId = new Map<string, AcpProbeResult>();

  // Partition: local binaries vs npx/uvx package launchers. A first-run `npx`
  // download is heavy enough to starve a LOCAL agent sharing the same batch
  // (its stdout 'data' misses the handshake window → false timeout). So probe
  // all locals first (clean resources, fast), THEN the package ones — which
  // are inherently slow on first run — at low concurrency.
  const local: string[] = [];
  const pkg: string[] = [];
  const cmds = new Map<string, ACPSubagentRunnerOptions | null>();
  for (const id of ids) {
    const cmd = opts.resolveCmd(id);
    cmds.set(id, cmd);
    if (!cmd) continue;
    if (cmd.command === 'npx' || cmd.command === 'uvx') pkg.push(id);
    else local.push(id);
  }

  const runPhase = async (
    phaseIds: string[],
    concurrency: number,
    timeoutMs: number,
  ): Promise<void> => {
    let next = 0;
    const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, phaseIds.length));
    const workers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w++) {
      workers.push(
        (async () => {
          while (true) {
            const current = next++;
            if (current >= phaseIds.length) return;
            const id = phaseIds[current]!;
            if (opts.signal?.aborted) {
              byId.set(id, { id, ok: false, ms: 0, error: 'aborted' });
              continue;
            }
            const cmd = cmds.get(id)!;
            const r = await probeAcpAgent(cmd!, {
              timeoutMs,
              ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
            });
            r.id = id; // probeAcpAgent derives id from cmd.role; pin to our id.
            byId.set(id, r);
            opts.onProgress?.(id, r);
          }
        })(),
      );
    }
    await Promise.all(workers);
  };

  // Unknown ids resolve to null — record immediately.
  for (const id of ids) {
    if (cmds.get(id) === null) {
      const r: AcpProbeResult = { id, ok: false, ms: 0, error: 'unknown agent' };
      byId.set(id, r);
      opts.onProgress?.(id, r);
    }
  }

  await runPhase(local, opts.concurrency ?? 4, localTimeout);
  // Package launchers run AFTER locals (so npm downloads never starve a local
  // agent's handshake), at low concurrency with a long timeout — first-run
  // `npx`/`uvx` fetches are inherently slow.
  await runPhase(pkg, 2, pkgTimeout);

  // Preserve the caller's input order.
  return ids.map((id) => byId.get(id)!);
}

/** `wstack acp list|sync|spawn|parallel|probe|bench` — driving other ACP agents. */

import {
  type ACPProgressEvent,
  type AcpAgentCommandOverrides,
  defaultPermissionPolicy,
  EnsembleRegistry,
  probeAcpAgents,
  renderAcpBenchText,
  resolveAcpAgentCommand,
  runAcpBench,
  runEnsemble,
  runOneAcpTask,
} from '@wrongstack/acp';
import { acpRuntimeValuesError } from '@wrongstack/contracts/types/acp-runtime';
import { inspectAcpRuntime, wrongstackBridgeSetup } from '@wrongstack/fleet';
import { formatAcpAgentList } from '../../acp-agent-list.js';
import {
  type LoadedAcpRegistry,
  loadCachedAcpRegistry,
  refreshAcpRegistry,
} from '../../acp-registry-cache.js';
import type { SubcommandDeps } from '../contracts.js';

/** User-config ACP command overrides (never sourced from in-project config). */
function acpOverrides(deps: SubcommandDeps): AcpAgentCommandOverrides | undefined {
  return deps.config.acp?.agents;
}

/** Load the synced registry cache, or null if never synced / unavailable. */
async function loadLive(deps: SubcommandDeps): Promise<LoadedAcpRegistry | null> {
  return deps.paths ? loadCachedAcpRegistry(deps.paths) : null;
}

export async function listACPAgents(deps: SubcommandDeps): Promise<number> {
  const detected = await new EnsembleRegistry().list();
  const live = await loadLive(deps);
  deps.renderer.write(`${formatAcpAgentList({ live, detected })}\n`);
  return 0;
}

export async function syncACPRegistry(deps: SubcommandDeps): Promise<number> {
  if (!deps.paths) {
    deps.renderer.writeError('Cannot sync: no cache directory available.\n');
    return 1;
  }
  deps.renderer.writeInfo('Fetching the official ACP registry…\n');
  try {
    const { count, location } = await refreshAcpRegistry(deps.paths);
    deps.renderer.write(`Synced ${count} agents from the official ACP registry.\n`);
    deps.renderer.writeInfo(`Cached at ${location}\n`);
    return 0;
  } catch (err) {
    deps.renderer.writeError(
      `ACP registry sync failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    deps.renderer.write('The bundled offline catalog is still available via `wstack acp list`.\n');
    return 1;
  }
}

export async function spawnACPAgent(args: string[], deps: SubcommandDeps): Promise<number> {
  const [subagentId, ...taskParts] = args;
  if (!subagentId) {
    deps.renderer.writeError('Usage: wstack acp spawn <agent-id> <task>\n');
    deps.renderer.write('Run `wstack acp list` to see available agents.\n');
    return 1;
  }

  const runtimeValues = { ...deps.config.modelRuntime?.acp?.[subagentId] };
  const jsonOptions = deps.flags?.['acp-options'];
  if (typeof jsonOptions === 'string') {
    try {
      const parsed: unknown = JSON.parse(jsonOptions);
      const error = acpRuntimeValuesError(parsed);
      if (error) throw new Error(error);
      Object.assign(runtimeValues, parsed);
    } catch (error) {
      deps.renderer.writeError(
        `Invalid --acp-options JSON: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  if (typeof deps.flags?.['acp-option'] === 'string')
    taskParts.push(`--acp-option=${deps.flags['acp-option']}`);
  const taskWords: string[] = [];
  for (const part of taskParts) {
    if (!part.startsWith('--acp-option=')) {
      taskWords.push(part);
      continue;
    }
    const pair = part.slice('--acp-option='.length);
    const split = pair.indexOf('=');
    if (split <= 0) {
      deps.renderer.writeError('Use --acp-option=<option-id>=<value>\n');
      return 1;
    }
    Object.defineProperty(runtimeValues, pair.slice(0, split), {
      value: pair.slice(split + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const task = taskWords.join(' ');
  if (!task) {
    deps.renderer.writeError('Usage: wstack acp spawn <agent-id> <task>\n');
    deps.renderer.write('Task description is required.\n');
    return 1;
  }

  const live = await loadLive(deps);
  const cmd = resolveAcpAgentCommand(subagentId, acpOverrides(deps), live?.byId);
  if (!cmd) {
    deps.renderer.writeError(`Unknown ACP agent: ${subagentId}\n`);
    deps.renderer.write('Run `wstack acp list` (or `wstack acp sync`) to see available agents.\n');
    return 1;
  }

  deps.renderer.writeInfo(`Spawning ACP agent '${subagentId}'…\n`);

  // Wire Ctrl+C to an AbortSignal so a long-running external agent is
  // cancelled (runOneAcpTask tears the child down on signal + in its finally).
  const ac = new AbortController();
  const cleanup = () => ac.abort();
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    deps.renderer.writeInfo('Running task…\n');
    const result = await runOneAcpTask({
      ...(Object.keys(runtimeValues).length ? { runtimeValues } : {}),
      command: cmd.command,
      ...(cmd.args !== undefined ? { args: cmd.args } : {}),
      ...(cmd.env !== undefined ? { env: cmd.env } : {}),
      role: subagentId,
      task,
      // The project, not wherever `wstack` was launched from: the bridge's
      // servers are bound to it, and the agent must edit the same tree.
      cwd: deps.projectRoot,
      projectRoot: deps.projectRoot,
      signal: ac.signal,
      permissionPolicy: defaultPermissionPolicy,
      sessionSetup: wrongstackBridgeSetup(subagentId, deps.projectRoot, deps.config.acp?.bridge),
      onProgress: (event) => {
        const line = formatProgress(event);
        if (line) deps.renderer.writeInfo(`  ${line}\n`);
      },
    });

    deps.renderer.write('\n--- Result ---\n');
    deps.renderer.write(result.result.length > 0 ? result.result : 'no result');
    deps.renderer.write('\n---------------\n');
    deps.renderer.writeInfo(
      `Done. iterations=${result.iterations} toolCalls=${result.toolCalls}\n`,
    );
    return 0;
  } catch (err) {
    // runOneAcpTask throws structured SubagentError shapes; surface the
    // `kind` for clarity (e.g. aborted_by_parent, bridge_failed).
    const e = err as { kind?: string; message?: string };
    const detail = e.kind ? `[${e.kind}] ` : '';
    const message = e.message ?? (err instanceof Error ? err.message : String(err));
    deps.renderer.writeError(`ACP agent error: ${detail}${message}\n`);
    return 1;
  } finally {
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
  }
}

export async function readACPAgentConfig(args: string[], deps: SubcommandDeps): Promise<number> {
  const agentId = args[0];
  if (!agentId || args.slice(1).some((x) => x !== '--json')) {
    deps.renderer.writeError('Usage: wstack acp config <agent-id> [--json]\n');
    return 1;
  }
  try {
    const result = await inspectAcpRuntime(deps.config, deps.projectRoot, agentId);
    deps.renderer.write(
      args.includes('--json') || deps.flags?.['json'] === true
        ? `${JSON.stringify(result)}\n`
        : `${result.options.map((x) => `${x.id}: ${x.currentValue}\n  ${x.options.map((y) => y.value).join(' | ')}`).join('\n') || 'No model or effort settings advertised.'}\n`,
    );
    return 0;
  } catch (error) {
    deps.renderer.writeError(
      `ACP settings failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

/**
 * Render one streamed ACP progress event as a compact one-line summary
 * for the CLI. Returns '' for events that shouldn't print a line (the
 * final assistant text is already shown in the result block, so we skip
 * `message`/`raw` to avoid double-printing).
 */
function formatProgress(event: ACPProgressEvent): string {
  switch (event.type) {
    case 'tool_call':
      return `▸ ${event.toolCall.title} (${event.toolCall.status})`;
    case 'tool_call_update':
      return event.toolCall.status === 'completed' || event.toolCall.status === 'failed'
        ? `  ↳ ${event.toolCall.title}: ${event.toolCall.status}`
        : '';
    case 'diff':
      return `✎ ${event.diff.path}${event.diff.oldText === null ? ' (new)' : ''}`;
    case 'plan':
      return `☰ plan: ${event.entries.length} step(s)`;
    default:
      return '';
  }
}

export async function parallelACPAgents(args: string[], deps: SubcommandDeps): Promise<number> {
  const [csv, ...taskParts] = args;
  if (!csv) {
    deps.renderer.writeError('Usage: wstack acp parallel <agent-id-csv> <task>\n');
    deps.renderer.write('Example: wstack acp parallel claude-code,gemini-cli "review this diff"\n');
    return 1;
  }
  const task = taskParts.join(' ');
  if (!task) {
    deps.renderer.writeError('Usage: wstack acp parallel <agent-id-csv> <task>\n');
    deps.renderer.writeError('Task description is required.\n');
    return 1;
  }

  // Forward SIGINT to abort the run. Each child process tears down in
  // its own finally; the AbortController propagates into the agent.
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const overrides = acpOverrides(deps);
    const live = await loadLive(deps);
    const result = await runEnsemble({
      agentIds: csv,
      task,
      resolveCmd: (id) => {
        const cmd = resolveAcpAgentCommand(id, overrides, live?.byId);
        return cmd
          ? {
              ...cmd,
              cwd: deps.projectRoot,
              projectRoot: deps.projectRoot,
              sessionSetup: wrongstackBridgeSetup(id, deps.projectRoot, deps.config.acp?.bridge),
            }
          : null;
      },
      signal: ac.signal,
      onProgress: (agentId, event) => {
        const line = formatProgress(event);
        if (line) deps.renderer.writeInfo(`  [${agentId}] ${line}\n`);
      },
    });

    // Surface skipped agents up-front, before the per-agent output.
    const skipped = result.results.filter((r) => r.status === 'skipped');
    if (skipped.length > 0) {
      deps.renderer.writeWarning(
        `Skipping ${skipped.length} agent(s) not installed: ${skipped.map((s) => `${s.agentId} (${s.reason ?? 'not installed'})`).join(', ')}\n`,
      );
    }
    if (result.summary.succeeded + result.summary.failed + result.summary.cancelled === 0) {
      deps.renderer.writeError('No installed agents to run.\n');
      deps.renderer.write('Run `wstack acp list` to see what is available.\n');
      return 1;
    }

    const fannedOut = result.results
      .filter((r) => r.status !== 'skipped')
      .map((r) => r.agentId)
      .join(', ');
    deps.renderer.writeInfo(
      `Fanning out to ${result.summary.succeeded + result.summary.failed + result.summary.cancelled} agent(s): ${fannedOut}\n`,
    );
    deps.renderer.writeInfo(`Task: ${result.task}\n\n`);

    // Render each result under a clear header, in input order.
    for (const r of result.results) {
      if (r.status === 'skipped') continue;
      deps.renderer.write(`\n=== ${r.agentId} ===\n`);
      if (r.status === 'success') {
        deps.renderer.write(r.result && r.result.length > 0 ? r.result : '(no result)');
        deps.renderer.write(
          `\n[${r.agentId}] success  ${r.durationMs}ms  iterations=${r.iterations} toolCalls=${r.toolCalls}\n`,
        );
      } else if (r.status === 'failed') {
        deps.renderer.writeError(
          `[${r.error?.kind ?? 'unknown'}] ${r.error?.message ?? 'failed'}\n`,
        );
        deps.renderer.write(`[${r.agentId}] failed  ${r.durationMs}ms\n`);
      } else {
        // cancelled
        deps.renderer.writeError(
          `[${r.error?.kind ?? 'aborted'}] ${r.error?.message ?? 'cancelled'}\n`,
        );
        deps.renderer.write(`[${r.agentId}] cancelled  ${r.durationMs}ms\n`);
      }
    }

    const { succeeded, failed, cancelled, skipped: skip } = result.summary;
    deps.renderer.write(
      `\nParallel summary: ${succeeded} succeeded, ${failed} failed, ${cancelled} cancelled, ${skip} skipped.\n`,
    );

    // 0 if at least one agent succeeded, 1 otherwise.
    return succeeded > 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export async function probeACPAgents(args: string[], deps: SubcommandDeps): Promise<number> {
  const csv = args.join(' ');
  let ids: string[];
  if (csv) {
    ids = csv
      .split(',')
      .flatMap((s) => s.split(/\s+/))
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    const detected = await new EnsembleRegistry().list();
    ids = detected.filter((a) => a.installed).map((a) => a.id);
  }
  if (ids.length === 0) {
    deps.renderer.writeError('No installed agents to probe.\n');
    return 1;
  }
  const overrides = acpOverrides(deps);
  const live = await loadLive(deps);
  deps.renderer.writeInfo(
    `Probing ${ids.length} agent(s)… (npx-based agents may download on first run)\n`,
  );
  const results = await probeAcpAgents({
    agentIds: ids,
    resolveCmd: (id) => resolveAcpAgentCommand(id, overrides, live?.byId),
    projectRoot: deps.cwd ?? process.cwd(),
    onProgress: (id, r) => deps.renderer.writeInfo(`  ${r.ok ? '✓' : '✗'} ${id} (${r.ms}ms)\n`),
  });
  deps.renderer.write('\nACP handshake probe:\n\n');
  for (const r of results) {
    if (r.ok) {
      const info = r.agentInfo ? ` — ${r.agentInfo.name} ${r.agentInfo.version}` : '';
      deps.renderer.write(`  ✓ ${r.id.padEnd(16)} ok  ${r.ms}ms${info}\n`);
    } else {
      deps.renderer.write(`  ✗ ${r.id.padEnd(16)} ${r.error ?? 'failed'}  (${r.ms}ms)\n`);
    }
  }
  const ok = results.filter((r) => r.ok).length;
  deps.renderer.write(`\n${ok} of ${results.length} agents completed the ACP handshake.\n`);
  return ok > 0 ? 0 : 1;
}

export async function benchACPAgents(args: string[], deps: SubcommandDeps): Promise<number> {
  // `--fs` is parsed into deps.flags by the subcommand arg parser (flags never
  // arrive in `args`); tolerate a literal token too for safety.
  const checkFs = deps.flags?.fs === true || deps.flags?.fs === 'true' || args.includes('--fs');
  const csv = args.filter((a) => a !== '--fs').join(' ');

  let ids: string[];
  if (csv) {
    ids = csv
      .split(',')
      .flatMap((s) => s.split(/\s+/))
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    const detected = await new EnsembleRegistry().list();
    ids = detected.filter((a) => a.installed).map((a) => a.id);
  }
  if (ids.length === 0) {
    deps.renderer.writeError('No installed agents to bench.\n');
    deps.renderer.write('Pass ids explicitly: `wstack acp bench gemini-cli,codex-cli`.\n');
    return 1;
  }

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const overrides = acpOverrides(deps);
    const live = await loadLive(deps);
    deps.renderer.writeInfo(
      `Benching ${ids.length} agent(s)${checkFs ? ' (with fs check)' : ''}: ${ids.join(', ')}…\n`,
    );
    const result = await runAcpBench({
      agentIds: ids,
      resolveCmd: (id) => resolveAcpAgentCommand(id, overrides, live?.byId),
      projectRoot: deps.cwd ?? process.cwd(),
      checkFs,
      signal: ac.signal,
      onProgress: (agentId, phase, r) => {
        if (phase === 'start') deps.renderer.writeInfo(`  ▸ ${agentId}…\n`);
        else if (r) deps.renderer.writeInfo(`  ↳ ${agentId}: ${r.status}\n`);
      },
    });
    deps.renderer.write(`\n${renderAcpBenchText(result)}\n`);
    // Exit 0 if at least one agent passed; 1 otherwise.
    return result.summary.pass > 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

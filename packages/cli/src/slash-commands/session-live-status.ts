import type { SessionRegistry } from '@wrongstack/core/storage';
import { getSessionRegistry } from '@wrongstack/core/storage';
import { color, isPidAlive, toErrorMessage } from '@wrongstack/core/utils';

// ── Live session helpers (SessionRegistry) ──────────────────────────────

function statusIcon(status: string): string {
  switch (status) {
    case 'active':
      return color.green('●');
    case 'idle':
      return color.cyan('◉');
    case 'closing':
      return color.yellow('◐');
    case 'stale':
      return color.dim('○');
    default:
      return color.dim('?');
  }
}

function agentStatusIcon(status: string): string {
  switch (status) {
    case 'running':
      return color.green('▶');
    case 'streaming':
      return color.cyan('↻');
    case 'waiting_user':
      return color.yellow('⏳');
    case 'error':
      return color.red('✗');
    case 'idle':
      return color.dim('■');
    default:
      return color.dim('?');
  }
}

export function formatBytes(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '0B';
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtDuration(startedAt: string): string {
  const diff = Date.now() - new Date(startedAt).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtAgentLine(agent: {
  name: string;
  status: string;
  currentTool?: string | undefined;
  iterations: number;
  toolCalls: number;
}): string {
  const icon = agentStatusIcon(agent.status);
  const tool = agent.currentTool ? color.dim(` [${agent.currentTool}]`) : '';
  const stats = color.dim(` ${agent.iterations} iter · ${agent.toolCalls} tools`);
  return `    ${icon} ${agent.name}${tool}${stats}`;
}

function getRegistry(): SessionRegistry | undefined {
  try {
    return getSessionRegistry();
  } catch {
    return undefined;
  }
}

export function isSafeSessionKillPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
}

/**
 * Build a compact one-line-per-event summary of a recovery plan's
 * pending events. Stops early once we've shown enough to be useful
 * (cap = 12 lines) — the recovery is informational, not a re-execution.
 */
export function summarizePending(
  events: import('@wrongstack/contracts/types').SessionEvent[],
): string[] {
  const lines: string[] = [];
  const cap = 12;
  for (const ev of events.slice(-cap)) {
    const t = 'ts' in ev ? color.dim(String(ev.ts).slice(11, 19)) : color.dim('--:--:--');
    const kind = color.cyan(String(ev.type).padEnd(18));
    lines.push(`    ${t}  ${kind}  ${summariseEvent(ev)}`);
  }
  if (events.length > cap) {
    lines.push(color.dim(`    … and ${events.length - cap} more`));
  }
  return lines;
}

function summariseEvent(ev: import('@wrongstack/contracts/types').SessionEvent): string {
  switch (ev.type) {
    case 'user_input': {
      const text =
        'text' in ev && typeof ev.text === 'string'
          ? ev.text
          : Array.isArray((ev as { content?: unknown | undefined }).content)
            ? '…'
            : '';
      return color.dim(text.length > 60 ? text.slice(0, 59) + '…' : text);
    }
    case 'llm_response':
      return color.dim('(model reply)');
    case 'tool_use':
      return color.dim(`name=${(ev as { name?: string | undefined }).name ?? '?'}`);
    case 'tool_result':
      return color.dim(`name=${(ev as { name?: string | undefined }).name ?? '?'}`);
    case 'in_flight_start':
      return color.dim(`context="${(ev as { context?: string | undefined }).context ?? ''}"`);
    case 'in_flight_end':
      return color.dim(`reason=${(ev as { reason?: string | undefined }).reason ?? '?'}`);
    case 'checkpoint':
      return color.dim(
        `promptIndex=${(ev as { promptIndex?: number | undefined }).promptIndex ?? '?'}`,
      );
    case 'compaction':
      return color.dim('(compaction)');
    case 'error':
      return color.red(String((ev as { message?: string | undefined }).message ?? ''));
    default:
      return color.dim('…');
  }
}

// ── Live session tracking (SessionRegistry) ────────────────────────────

export async function listLiveSessions(): Promise<{ message: string }> {
  const registry = getRegistry();
  if (!registry) {
    return { message: color.dim('SessionRegistry not available (headless mode).') };
  }

  const sessions = await registry.list();
  const live = sessions.filter((s) => s.status !== 'stale' && s.status !== 'closing');
  const stale = sessions.filter((s) => s.status === 'stale');

  if (live.length === 0 && stale.length === 0) {
    return { message: color.dim('No live sessions. Start a session to see it here.') };
  }

  const lines: string[] = [color.bold('══ Live Sessions ══'), ''];

  for (const s of live) {
    const icon = statusIcon(s.status);
    const name = color.bold(s.projectName);
    const slug = color.dim(`[${s.projectSlug}]`);
    const dur = color.dim(fmtDuration(s.startedAt));
    const agents = color.cyan(`${s.agentCount} agent${s.agentCount === 1 ? '' : 's'}`);
    const wd = color.dim(`wd: ${s.workingDir}`);
    const branch = s.gitBranch ? color.magenta(`⎇ ${s.gitBranch}`) : '';

    lines.push(`  ${icon} ${name} ${slug}  ${dur}  PID ${s.pid}`);
    lines.push(`       ${agents}  ${wd}  ${branch}`);

    if (s.agents.length > 0) {
      for (const agent of s.agents.slice(0, 5)) {
        lines.push(fmtAgentLine(agent));
      }
      if (s.agents.length > 5) {
        lines.push(color.dim(`    ... and ${s.agents.length - 5} more`));
      }
    }
    lines.push('');
  }

  if (stale.length > 0) {
    lines.push(color.dim('Recently Closed:'));
    for (const s of stale.slice(0, 3)) {
      lines.push(color.dim(`  ○ ${s.projectName} [${s.projectSlug}]  ${fmtDuration(s.startedAt)}`));
    }
    lines.push('');
  }

  lines.push(color.dim(`Registry: ${registry.registryPath}  |  /sessions status <id> for detail`));

  return { message: lines.join('\n') };
}

export async function sessionStatusDetail(sessionId: string): Promise<{ message: string }> {
  const registry = getRegistry();
  if (!registry) {
    return { message: color.dim('SessionRegistry not available.') };
  }

  const entry = await registry.get(sessionId);
  if (!entry) {
    return {
      message: color.yellow(
        `Session not found: ${sessionId}. Use /sessions status to list live sessions.`,
      ),
    };
  }

  const lines: string[] = [
    color.bold(`Session: ${entry.sessionId}`),
    '',
    `  Project:   ${entry.projectName} [${entry.projectSlug}]`,
    `  Root:      ${entry.projectRoot}`,
    `  Work Dir:  ${entry.workingDir}`,
    `  Branch:    ${entry.gitBranch ? color.magenta('⎇ ' + entry.gitBranch) : color.dim('(none)')}`,
    `  Status:    ${statusIcon(entry.status)} ${entry.status}`,
    `  Started:   ${entry.startedAt}`,
    `  Duration:  ${fmtDuration(entry.startedAt)}`,
    `  PID:       ${entry.pid}`,
    `  Agents:    ${entry.agentCount}`,
    entry.status !== 'stale'
      ? color.dim(
          `  Transcript: ~/.wrongstack/projects/${entry.projectSlug}/sessions/${entry.sessionId}.jsonl`,
        )
      : '',
    '',
  ];

  if (entry.agents.length > 0) {
    lines.push(color.bold('Live agents:'));
    for (const agent of entry.agents) {
      lines.push(fmtAgentLine(agent));
      lines.push(color.dim(`       last activity: ${agent.lastActivityAt}`));
    }
    lines.push('');
  }

  lines.push(...(await recordedAgentLines(entry)));

  return { message: lines.join('\n') };
}

/**
 * The agents this session RECORDED, read back from its own journal.
 *
 * Distinct from the live list above, which is presence held by the
 * SessionRegistry: that list empties the moment a session ends, so a finished
 * or crashed run could never answer "what ran in here, and where did it
 * write". The journal can, because the roster is derived from it.
 *
 * Best-effort by design. It goes through the project daemon with
 * `callExisting`, which will not WAKE a daemon — inspecting a session is not
 * authority to start that project's IPC owner — so a project whose daemon is
 * down contributes nothing to the panel instead of failing the command.
 */
async function recordedAgentLines(entry: {
  sessionId: string;
  projectRoot: string;
}): Promise<string[]> {
  try {
    const { SessionCatalogProjectClient } = await import('@wrongstack/core/storage');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const wpaths = resolveWstackPaths({ projectRoot: entry.projectRoot });
    const client = new SessionCatalogProjectClient({
      projectDir: wpaths.projectDir,
      projectRoot: entry.projectRoot,
    });
    const agents = await client.callExisting('list_session_agents', {
      sessionId: entry.sessionId,
    });
    if (agents.length === 0) return [];
    const lines = [color.bold('Recorded agents (from journal):')];
    for (const agent of agents) {
      const role = agent.role ? color.dim(` (${agent.role})`) : '';
      const model = agent.model ? color.dim(` · ${agent.model}`) : '';
      lines.push(`    ${agentStatusIcon(agent.status)} ${agent.agentId}${role}${model}`);
      if (agent.transcriptPath) {
        lines.push(color.dim(`       transcript: ${agent.transcriptPath}`));
      } else if (agent.interleavedEventCount > 0) {
        lines.push(
          color.dim(
            `       ${agent.interleavedEventCount} event(s) interleaved into this transcript`,
          ),
        );
      }
      if (agent.error) lines.push(color.dim(`       error: ${agent.error}`));
    }
    lines.push('');
    return lines;
  } catch {
    return [];
  }
}

export async function listLiveAgents(): Promise<{ message: string }> {
  const registry = getRegistry();
  if (!registry) {
    return { message: color.dim('SessionRegistry not available.') };
  }

  const sessions = await registry.list();
  const live = sessions.filter((s) => s.status !== 'stale' && s.status !== 'closing');

  if (live.length === 0) {
    return { message: color.dim('No live sessions.') };
  }

  const lines: string[] = [color.bold('══ Live Agents ══'), ''];

  for (const s of live) {
    lines.push(color.dim(`${s.projectName} [${s.projectSlug}] ⎇ ${s.gitBranch ?? '—'}`));
    if (s.agents.length === 0) {
      lines.push(color.dim('  (no agents)'));
    } else {
      for (const a of s.agents) {
        const icon = agentStatusIcon(a.status);
        const tool = a.currentTool ? color.dim(` [${a.currentTool}]`) : '';
        const stats = color.dim(`${a.iterations} iter · ${a.toolCalls} tools`);
        lines.push(`  ${icon} ${a.name}${tool}  ${stats}`);
      }
    }
    lines.push('');
  }

  return { message: lines.join('\n') };
}

export async function killSession(
  sessionId: string,
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean | null>,
): Promise<{ message: string }> {
  const registry = getRegistry();
  if (!registry) {
    return { message: color.dim('SessionRegistry not available.') };
  }

  const entry = await registry.get(sessionId);
  if (!entry) {
    return {
      message: color.yellow(`Session not found: ${sessionId}. It may have already exited.`),
    };
  }

  // Don't kill the current process
  if (entry.pid === process.pid) {
    return {
      message: color.yellow(
        `Cannot kill the current session (PID ${process.pid}). Use /exit or Ctrl+C instead.`,
      ),
    };
  }

  if (!isSafeSessionKillPid(entry.pid)) {
    return {
      message: color.yellow(
        `Refusing to kill unsafe session PID ${entry.pid}. The session registry entry may be corrupt.`,
      ),
    };
  }

  // Check if the process is still alive. Uses the shared probe so an EPERM
  // (alive, owned by another user) isn't reported to the user as "gone".
  if (!isPidAlive(entry.pid)) {
    return {
      message: color.dim(
        `Session ${sessionId} (PID ${entry.pid}) is no longer running. It will be pruned automatically.`,
      ),
    };
  }

  // Confirm before signalling another live process. confirm() resolves to its
  // default on non-TTY/EOF, so scripted callers proceed without hanging; pass
  // --force to skip the prompt entirely (confirm omitted).
  if (confirm) {
    const ok = await confirm(`Terminate ${entry.projectName} (PID ${entry.pid})?`, false);
    if (ok !== true) {
      return { message: color.dim('Kill cancelled.') };
    }
  }

  // Send SIGTERM
  try {
    process.kill(entry.pid, 'SIGTERM');
    return {
      message: color.green(
        `Sent termination signal to ${entry.projectName} (PID ${entry.pid}). ` +
          `The session will be removed from the registry shortly.`,
      ),
    };
  } catch (err) {
    return {
      message: color.red(`Failed to kill session: ${toErrorMessage(err)}`),
    };
  }
}

import type { SessionRegistry, SlashCommand } from '@wrongstack/core';
import { color, SessionRecovery } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { toErrorMessage } from '@wrongstack/core/utils';

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
    // Dynamic require to avoid import cycle in headless mode
    const mod = require('@wrongstack/core') as { getSessionRegistry?: () => SessionRegistry };
    return mod.getSessionRegistry?.();
  } catch {
    return undefined;
  }
}

export function isSafeSessionKillPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
}

export function buildSaveCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'save',
    category: 'Session',
    description: 'Save current session (auto by default; this forces flush).',
    async run(_args, ctx) {
      if (!ctx?.session) {
        return { message: 'No active session.' };
      }
      // Force buffered events to disk. Do NOT write a session_end here —
      // the session is still running; a mid-stream end marker corrupts
      // outcome/endedAt derivation for recovery and summaries.
      await ctx.session.flush();
      return { message: `Session ${ctx.session.id} flushed.` };
    },
  };
}

export function buildLoadCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'sessions',
    category: 'Session',
    aliases: ['resume', 'load'],
    description:
      'List recent sessions, show incomplete ones (--incomplete), or plan a recovery (--recover <id>).',
    async run(args) {
      const parts = args.split(/\s+/).filter(Boolean);
      const first = parts[0]?.toLowerCase();

      // /sessions status — live session tracking
      if (first === 'status') {
        const targetId = parts[1];
        if (targetId) {
          return sessionStatusDetail(targetId);
        }
        return listLiveSessions();
      }

      // /sessions live — alias for status
      if (first === 'live') {
        return listLiveSessions();
      }

      // /sessions agents — show only agent status across all sessions
      if (first === 'agents') {
        return listLiveAgents();
      }

      // /sessions kill <id> — terminate a running session by PID
      if (first === 'kill') {
        const targetId = parts[1];
        if (!targetId) {
          return { message: 'Usage: /sessions kill <sessionId>' };
        }
        return killSession(targetId);
      }

      const showIncomplete = parts.includes('--incomplete') || parts.includes('-i');
      const recoverIdx = parts.indexOf('--recover');
      const recoverTarget = recoverIdx >= 0 ? parts[recoverIdx + 1] : undefined;

      if (recoverTarget) {
        if (!opts.paths) {
          return { message: color.yellow('No paths configured — cannot build a recovery plan.') };
        }
        const recovery = new SessionRecovery(opts.paths.projectSessions);
        const plan = await recovery.recover(recoverTarget);
        if (!plan) {
          return {
            message: color.yellow(`No session log found for ${recoverTarget} (or it is empty).`),
          };
        }
        const lines: string[] = [
          color.bold(`Recovery plan for ${plan.sessionId}`),
          `  Stale: ${plan.stale ? color.yellow('yes') : color.green('no')}`,
        ];
        if (plan.context) {
          lines.push(`  Last in-flight context: ${color.cyan(plan.context)}`);
        }
        if (plan.lastCheckpoint && plan.lastCheckpoint.type === 'checkpoint') {
          const cp = plan.lastCheckpoint;
          lines.push(
            `  Last checkpoint: promptIndex=${cp.promptIndex} preview=${color.dim(`"${cp.promptPreview}"`)} at ${color.dim(cp.ts)}`,
          );
        } else {
          lines.push(`  Last checkpoint: ${color.dim('(none — full re-execution)')}`);
        }
        lines.push(
          `  Pending events: ${plan.pendingEvents.length} (the work that would re-run on resume)`,
        );
        if (plan.pendingEvents.length > 0) {
          const summary = summarizePending(plan.pendingEvents);
          lines.push(...summary);
        }
        lines.push('');
        lines.push(
          color.dim(
            plan.stale
              ? '  This session crashed mid-iteration. The full re-execution kernel is coming in a follow-up; for now use this plan to decide whether to start fresh.'
              : '  This session ended cleanly; the plan above describes the most recent turn(s) for context.',
          ),
        );
        return { message: lines.join('\n') };
      }

      if (showIncomplete) {
        if (!opts.paths) {
          return {
            message: color.yellow('No paths configured — cannot scan for incomplete sessions.'),
          };
        }
        const recovery = new SessionRecovery(opts.paths.projectSessions);
        const resumable = await recovery.listResumable();
        if (resumable.length === 0) {
          return {
            message: color.dim('No incomplete sessions. (Every recorded run ended cleanly.)'),
          };
        }
        const lines: string[] = [
          color.bold(`${resumable.length} incomplete session(s)`),
          color.dim('  (process died mid-iteration; the last event was in_flight_start)'),
          '',
        ];
        for (const s of resumable) {
          const t = color.dim(s.lastEventTs.slice(0, 19).replace('T', ' '));
          lines.push(
            `  ${color.cyan(s.sessionId)}  ${t}  ${color.dim(`${s.eventCount} events`)}  ${s.context}`,
          );
        }
        lines.push('');
        lines.push(
          color.dim(
            '  Resuming re-executes the in-flight work from the last checkpoint. Full resume is coming in a follow-up; for now use this list to identify crashes and decide whether to restart fresh.',
          ),
        );
        return { message: lines.join('\n') };
      }

      if (!opts.sessionStore) return { message: 'No session store configured.' };
      const list = await opts.sessionStore.list(10);
      if (list.length === 0) return { message: 'No saved sessions.' };
      const currentId = opts.context?.session?.id;
      const lines = list.map((s) => {
        // Build a compact stats column: tools, errors, outcome badge.
        const parts: string[] = [];
        parts.push(color.dim(`${s.tokenTotal.toLocaleString()} tok`));
        if (s.toolCallCount) {
          const toolStr = `${s.toolCallCount} call${s.toolCallCount === 1 ? '' : 's'}`;
          parts.push(s.toolErrorCount ? color.yellow(toolStr) : color.cyan(toolStr));
        }
        if (s.iterationCount) parts.push(color.dim(`${s.iterationCount} iter`));
        if (s.outcome) {
          const badge =
            s.outcome === 'completed'
              ? color.green('✓')
              : s.outcome === 'aborted'
                ? color.yellow('⚠')
                : s.outcome === 'error'
                  ? color.red('✗')
                  : color.dim('?');
          parts.push(badge);
        }
        const stat = parts.join(' ');
        const date = color.dim(s.startedAt.slice(0, 16).replace('T', ' '));
        const isCurrent = s.id === currentId;
        const marker = isCurrent ? color.cyan(' (current)') : '';
        return `  ${color.bold(s.id)}${marker}\n    ${date}  ${stat}\n    ${color.dim(s.title)}`;
      });
      const msg = [
        color.bold(`Recent sessions (${list.length}):`),
        ...lines,
        '',
        color.dim(
          `Resume: /resume to open interactive picker, or wstack resume ${list[0]?.id ?? '<id>'}`,
        ),
        color.dim('Tip: /resume --incomplete — list crashed sessions'),
      ].join('\n');
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}

export function buildExitCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'exit',
    category: 'App',
    aliases: ['quit', 'q'],
    description: 'Exit the REPL.',
    async run() {
      // Check for uncommitted changes before exit
      if (opts.onBeforeExit) {
        const result = await opts.onBeforeExit();
        if (result?.abort) {
          // warn but allow exit anyway
          opts.onExit?.();
          return { message: result.message ?? '', exit: true };
        }
      }
      opts.onExit?.();
      return { exit: true };
    },
  };
}

/**
 * Build a compact one-line-per-event summary of a recovery plan's
 * pending events. Stops early once we've shown enough to be useful
 * (cap = 12 lines) — the recovery is informational, not a re-execution.
 */
function summarizePending(events: import('@wrongstack/core').SessionEvent[]): string[] {
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

function summariseEvent(ev: import('@wrongstack/core').SessionEvent): string {
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

async function listLiveSessions(): Promise<{ message: string }> {
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

async function sessionStatusDetail(sessionId: string): Promise<{ message: string }> {
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
    lines.push(color.bold('Agents:'));
    for (const agent of entry.agents) {
      lines.push(fmtAgentLine(agent));
      lines.push(color.dim(`       last activity: ${agent.lastActivityAt}`));
    }
    lines.push('');
  }

  return { message: lines.join('\n') };
}

async function listLiveAgents(): Promise<{ message: string }> {
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

async function killSession(sessionId: string): Promise<{ message: string }> {
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

  // Check if the process is still alive
  try {
    process.kill(entry.pid, 0);
  } catch {
    return {
      message: color.dim(
        `Session ${sessionId} (PID ${entry.pid}) is no longer running. It will be pruned automatically.`,
      ),
    };
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
      message: color.red(
        `Failed to kill session: ${toErrorMessage(err)}`,
      ),
    };
  }
}

/** Fleet slash-command adapters for the CLI command host. */
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { Director } from '@wrongstack/core/coordination';
import { FLEET_ROSTER } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import { loadDirectorState } from '@wrongstack/core/storage';
import { AgentError } from '@wrongstack/core/types';
import { color, expectDefined } from '@wrongstack/core/utils';
import { formatFleetBudgetLines } from '../fleet/host-status.js';
import type { MultiAgentHost } from '../multi-agent.js';
import { fmtTaskResultLine } from '../utils.js';
import type { BuiltinSlashCommandDeps } from './slash-commands.js';

type SlashCommandDeps = BuiltinSlashCommandDeps;
type FleetCommandHandlers = Pick<
  SlashCommandDeps,
  | 'onSpawn'
  | 'onSpawnAndWait'
  | 'onAgents'
  | 'onFleet'
  | 'onFleetStatus'
  | 'onFleetBudget'
  | 'onFleetUsage'
  | 'onFleetKill'
  | 'onFleetTerminate'
  | 'onFleetSpawn'
  | 'onFleetLog'
  | 'onFleetRetry'
  | 'onDirector'
>;

interface FleetCommandHandlersInput {
  multiAgentHost: MultiAgentHost;
  getDirector: () => Director | null;
  events: EventBus;
  getSessionId: () => string;
  fleetRoot: string;
}

export function createFleetCommandHandlers(input: FleetCommandHandlersInput): FleetCommandHandlers {
  return {
    onSpawn: async (description, options) => {
      const { subagentId, taskId } = await input.multiAgentHost.spawn(description, options);
      const tags = [
        options?.provider,
        options?.model,
        options?.name ? `"${options.name}"` : undefined,
      ].filter((tag): tag is string => Boolean(tag));
      const suffix = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
      return `Spawned subagent ${subagentId}${suffix} for task ${taskId}. Use /agents to track progress.`;
    },
    onSpawnAndWait: async (description, options) => {
      const result = await input.multiAgentHost.spawnAndWait(description, options);
      const tags = [options?.provider, options?.model, options?.name].filter((tag): tag is string =>
        Boolean(tag),
      );
      const suffix = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
      const seconds = (result.durationMs / 1000).toFixed(result.durationMs < 10_000 ? 1 : 0);
      const icon =
        result.status === 'success'
          ? '✓'
          : result.status === 'timeout'
            ? '⏱'
            : result.status === 'stopped'
              ? '⊘'
              : '✗';
      const trimmed = typeof result.result === 'string' ? result.result.trim() : '';
      const preview = trimmed
        ? `\n${color.dim('─'.repeat(40))}\n${trimmed.slice(0, 600)}${trimmed.length > 600 ? '\n…' : ''}\n${color.dim('─'.repeat(40))}`
        : '';
      return [
        `${icon} ${color.bold(suffix ? suffix.slice(1) : 'subagent')} ${result.status} (${result.iterations} iter · ${result.toolCalls} tools · ${seconds}s)`,
        preview,
        result.error ? `  ${color.amber(`error: ${result.error.message}`)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
    onAgents: (subagentId) => formatAgents(input, subagentId),
    onFleet: (action, target) => handleFleetAction(input, action, target),
    onFleetStatus: () => input.getDirector()?.status() ?? null,
    onFleetBudget: () => input.multiAgentHost.budgetView(),
    onFleetUsage: () => input.getDirector()?.snapshot() ?? null,
    onFleetKill: () => killFleet(input.getDirector()),
    onFleetTerminate: async (subagentId) => {
      const director = input.getDirector();
      if (!director) return false;
      try {
        await director.terminate(subagentId);
        return true;
      } catch {
        return false;
      }
    },
    onFleetSpawn: async (role) => {
      const director = input.getDirector();
      if (!director) {
        throw new AgentError({
          message: 'Director is not available.',
          code: 'AGENT_RUN_FAILED',
          context: { phase: 'fleet-spawn', role },
        });
      }
      return director.spawn(
        FLEET_ROSTER[role] ?? {
          id: `manual-${Date.now()}`,
          name: role,
          maxIterations: 50,
          maxToolCalls: 200,
        },
      );
    },
    onFleetLog: (subagentId, mode) => readFleetLog(input.fleetRoot, subagentId, mode),
    onFleetRetry: (taskId) => retryInterruptedTasks(input, taskId),
    onDirector: async () => {
      const director = await input.multiAgentHost.ensureDirector();
      return director ? 'Director mode is active.' : 'Director is not available.';
    },
  };
}

function formatAgents(input: FleetCommandHandlersInput, subagentId?: string): string {
  const status = input.multiAgentHost.status();
  const icons: Record<string, string> = { running: '●', idle: '○', stopped: '⊘' };
  if (subagentId) {
    const live = status.live.find((agent) => agent.subagentId === subagentId);
    const completed = status.completed.filter((result) => result.subagentId === subagentId);
    const pending = status.pending.filter((task) => task.subagentId === subagentId);
    if (!live && completed.length === 0 && pending.length === 0) {
      return `No subagent found with id "${subagentId}".`;
    }
    const lines = [color.bold(`Agent ${subagentId.slice(0, 8)}`)];
    if (live) {
      lines.push(`  ${icons[live.status] ?? '?'}  status: ${live.status}`);
      if (live.task) lines.push(`  task: ${live.task}`);
    }
    for (const task of pending) {
      lines.push(`  ·  pending: ${task.taskId.slice(0, 8)} → ${task.description.slice(0, 60)}`);
    }
    for (const result of completed) {
      const formatted = fmtTaskResultLine(result, color);
      lines.push(
        `  ${formatted.mark}  ${result.taskId.slice(0, 8)} ${formatted.stats}${formatted.tail}`,
      );
    }
    const usage = input.getDirector()?.snapshot().perSubagent?.[subagentId];
    if (usage?.cost) lines.push(`  cost: ${usage.cost.toFixed(4)}`);
    if (usage?.iterations) lines.push(`  iterations: ${usage.iterations}`);
    if (usage?.toolCalls) lines.push(`  toolCalls: ${usage.toolCalls}`);
    return lines.join('\n');
  }
  const lines = [status.summary];
  for (const agent of status.live) {
    if (agent.status === 'running' || agent.status === 'idle') {
      lines.push(
        `  ${icons[agent.status] ?? '?'}  ${agent.subagentId.slice(0, 8)} ${agent.status}${agent.task ? ` — ${agent.task.slice(0, 60)}` : ''}`,
      );
    }
  }
  for (const task of status.pending) {
    lines.push(`  ·  pending  ${task.taskId.slice(0, 8)} → ${task.description.slice(0, 60)}`);
  }
  for (const result of status.completed) {
    const formatted = fmtTaskResultLine(result, color);
    lines.push(
      `  ${formatted.mark}  ${result.taskId.slice(0, 8)} ${formatted.stats}${formatted.tail}`,
    );
  }
  return lines.join('\n');
}

async function handleFleetAction(
  input: FleetCommandHandlersInput,
  action: string,
  target?: string,
): Promise<string> {
  if (action === 'status') return formatFleetStatus(input.multiAgentHost);
  if (action === 'usage') return formatFleetUsage(input.multiAgentHost);
  if (action === 'kill') {
    if (!target) return 'Usage: /fleet kill <subagent-id>';
    return (await input.multiAgentHost.kill(target))
      ? `Sent stop signal to ${target}.`
      : 'No coordinator is running yet — nothing to kill.';
  }
  if (action === 'manifest') {
    const manifest = await input.multiAgentHost.manifest();
    return manifest
      ? `Manifest written → ${manifest}`
      : 'Director is active but no subagents have been spawned — nothing to record yet.';
  }
  if (action === 'concurrency') {
    const current = input.multiAgentHost.getMaxConcurrent();
    if (!target) return `Concurrent-subagent ceiling: ${current}`;
    const next = Number.parseInt(target, 10);
    if (!Number.isFinite(next) || next < 1) {
      return `Invalid value "${target}". Concurrency must be an integer >= 1.`;
    }
    try {
      input.multiAgentHost.setMaxConcurrent(next);
      input.events.emit('concurrency.changed', { sessionId: input.getSessionId(), n: next });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return `Concurrent-subagent ceiling: ${current} → ${next}`;
  }
  return `Unknown fleet action: ${action}`;
}

function formatFleetStatus(host: MultiAgentHost): string {
  const status = host.status();
  const lines = [color.bold('Fleet status'), `  ${status.summary}`];
  const budget = status.budget ?? host.budgetView();
  lines.push(
    '',
    ...formatFleetBudgetLines(budget, {
      bold: color.bold,
      dim: color.dim,
      amber: color.amber,
    }),
  );
  const icons: Record<string, string> = { running: '●', idle: '○', stopped: '⊘' };
  const active = status.live.filter(
    (agent) => agent.status === 'running' || agent.status === 'idle',
  );
  if (active.length > 0) {
    lines.push('', color.dim('  Active'));
    for (const agent of active) {
      lines.push(
        `    ${icons[agent.status] ?? '?'} ${agent.subagentId.slice(0, 8)} ${agent.status}${agent.task ? ` · ${agent.task.slice(0, 50)}` : ''}`,
      );
    }
  }
  if (status.pending.length > 0) {
    lines.push('', color.dim('  Pending'));
    for (const task of status.pending) {
      lines.push(
        `    ·  ${task.taskId.slice(0, 8)} → ${task.subagentId.slice(0, 8)} · ${task.description.slice(0, 60)}`,
      );
    }
  }
  if (status.completed.length > 0) {
    lines.push('', color.dim('  Completed'));
    for (const result of status.completed) {
      const formatted = fmtTaskResultLine(result, color);
      lines.push(
        `    ${formatted.mark} ${result.taskId.slice(0, 8)} → ${result.subagentId.slice(0, 8)} · ${formatted.stats}${formatted.tail}`,
      );
    }
  }
  return lines.join('\n');
}

function formatFleetUsage(host: MultiAgentHost): string {
  const usage = host.usage();
  if (usage.rows.length === 0) return 'No completed subagent tasks yet.';
  const lines = [
    color.bold('Fleet usage'),
    color.dim('  subagent          tasks  iter  tools     ms  status'),
  ];
  for (const row of usage.rows) {
    lines.push(
      `  ${row.subagentId.slice(0, 14).padEnd(14)}  ${String(row.tasks).padStart(5)}  ${String(row.iterations).padStart(4)}  ${String(row.toolCalls).padStart(5)}  ${String(row.durationMs).padStart(5)}  ${row.status}`,
    );
  }
  lines.push(
    color.dim('  ─'.repeat(28)),
    `  ${'TOTAL'.padEnd(14)}  ${String(usage.totals.tasks).padStart(5)}  ${String(usage.totals.iterations).padStart(4)}  ${String(usage.totals.toolCalls).padStart(5)}  ${String(usage.totals.durationMs).padStart(5)}`,
  );
  return lines.join('\n');
}

async function killFleet(director: Director | null): Promise<number> {
  if (!director) return 0;
  let killed = 0;
  for (const subagent of director.status().subagents) {
    if (subagent.status === 'running' || subagent.status === 'idle') {
      try {
        await director.remove(subagent.id);
        killed++;
      } catch {
        // Best-effort fleet cleanup.
      }
    }
  }
  return killed;
}

interface Transcript {
  runId: string;
  subagentId: string;
  file: string;
  size: number;
}

const MAX_INLINE_RAW_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

async function readFleetLog(
  fleetRoot: string,
  subagentId: string | undefined,
  mode: 'summary' | 'raw',
): Promise<string> {
  const transcripts = await findTranscripts(path.join(fleetRoot, 'subagents'));
  if (transcripts === null) {
    return 'No fleet transcripts on disk — no subagents have been spawned for this session.';
  }
  if (transcripts.length === 0) return 'No subagent transcripts found on disk.';
  if (!subagentId) {
    return [
      `${transcripts.length} subagent transcript${transcripts.length === 1 ? '' : 's'} on disk:`,
      ...transcripts.map(
        (item) =>
          `  ${color.cyan(item.subagentId.padEnd(18))}  ${color.dim(item.runId.slice(0, 18))}  ${color.dim(`${(item.size / 1024).toFixed(1)} KB`)}`,
      ),
      'Use `/fleet log <subagentId>` for a summary, or append `raw` for the full JSONL.',
    ].join('\n');
  }
  const matches = transcripts.filter(
    (item) => item.subagentId === subagentId || item.subagentId.startsWith(subagentId),
  );
  if (matches.length === 0) {
    return `No transcript matched "${subagentId}". Run \`/fleet log\` to list available ids.`;
  }
  if (matches.length > 1) {
    return [
      `Ambiguous id "${subagentId}" — ${matches.length} matches:`,
      ...matches.map((item) => `  ${item.subagentId}  (${item.runId})`),
    ].join('\n');
  }
  const transcript = expectDefined(matches[0]);
  if (mode === 'raw') {
    if (transcript.size > MAX_INLINE_RAW_TRANSCRIPT_BYTES) {
      return [
        `Transcript is ${(transcript.size / 1024 / 1024).toFixed(1)} MiB; refusing to load it into chat history.`,
        `Read it directly from: ${transcript.file}`,
        `Inline raw limit: ${MAX_INLINE_RAW_TRANSCRIPT_BYTES / 1024 / 1024} MiB.`,
      ].join('\n');
    }
    return fs.readFile(transcript.file, 'utf8');
  }
  return summarizeTranscript(transcript);
}

async function findTranscripts(root: string): Promise<Transcript[] | null> {
  let runIds: string[];
  try {
    runIds = await fs.readdir(root);
  } catch {
    return null;
  }
  const byRun = await Promise.all(
    runIds.map(async (runId) => {
      const directory = path.join(root, runId);
      let files: string[];
      try {
        files = await fs.readdir(directory);
      } catch {
        return [];
      }
      const found = await Promise.all(
        files
          .filter((file) => file.endsWith('.jsonl'))
          .map(async (file): Promise<Transcript | null> => {
            const fullPath = path.join(directory, file);
            try {
              const stat = await fs.stat(fullPath);
              return {
                runId,
                subagentId: file.replace(/\.jsonl$/, ''),
                file: fullPath,
                size: stat.size,
              };
            } catch {
              return null;
            }
          }),
      );
      return found.filter((item): item is Transcript => item !== null);
    }),
  );
  return byRun.flat();
}

async function summarizeTranscript(transcript: Transcript): Promise<string> {
  const counts: Record<string, number> = {};
  const tools = new Map<string, number>();
  let firstUser: string | null = null;
  let lastResponse: string | null = null;
  let iterations = 0;
  let eventCount = 0;
  let streamError: unknown;
  const stream = createReadStream(transcript.file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { type: string; content?: unknown; name?: string };
          eventCount++;
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          if (event.type === 'user_input' && !firstUser)
            firstUser = eventText(event.content).slice(0, 120);
          if (event.type === 'llm_response') {
            const text = eventText(event.content);
            if (text) lastResponse = text.slice(0, 240);
            iterations++;
          }
          if (event.type === 'tool_use' && event.name) {
            tools.set(event.name, (tools.get(event.name) ?? 0) + 1);
          }
        } catch {
          // Ignore malformed historical events.
        }
      }
    } catch (err) {
      // Readline can reject mid-iteration (e.g. ERR_STREAM_PREMATURE_CLOSE
      // when the underlying stream is destroyed, or a transient fs read
      // error). Map those to a degraded summary instead of letting the
      // rejection propagate as an unhandled async-iterator failure.
      streamError = err;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  const degradedNote = streamError
    ? color.dim(`  (summary truncated: ${(streamError as Error).message ?? 'stream error'})`)
    : null;
  const breakdown =
    tools.size > 0
      ? [...tools.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => `${name}×${count}`)
          .join(', ')
      : '(none)';
  const output = [
    color.bold(`Subagent ${transcript.subagentId}`) + color.dim(`  (run ${transcript.runId})`),
    `  ${eventCount} events  ·  ${iterations} llm iterations  ·  ${(transcript.size / 1024).toFixed(1)} KB`,
    `  tools: ${breakdown}`,
  ];
  if (degradedNote) output.push(degradedNote);
  if (firstUser) output.push('', color.dim('  task:'), `  ${firstUser}`);
  if (lastResponse) output.push('', color.dim('  last response:'), `  ${lastResponse}`);
  output.push('', color.dim('  event mix:'));
  for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    output.push(`    ${type.padEnd(20)} ${count}`);
  }
  output.push('', color.dim('Use `/fleet log <id> raw` for the full JSONL.'));
  return output.join('\n');
}

function eventText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join(' ');
}

async function retryInterruptedTasks(
  input: FleetCommandHandlersInput,
  taskId?: string,
): Promise<string> {
  const director = await input.multiAgentHost.ensureDirector();
  if (!director) return 'Director is not available.';
  const prior = await loadDirectorState(path.join(input.fleetRoot, 'director-state.json'));
  if (!prior) return 'No prior director-state.json found — nothing to retry.';
  const interrupted = prior.tasks.filter(
    (task) => task.status === 'running' || task.status === 'pending',
  );
  if (interrupted.length === 0) {
    return 'No interrupted tasks: every prior task reached a terminal state.';
  }
  if (!taskId) {
    return [
      `${interrupted.length} interrupted task${interrupted.length === 1 ? '' : 's'} from prior run:`,
      ...interrupted.map((task) => {
        const owner = task.subagentId
          ? prior.subagents.find((subagent) => subagent.id === task.subagentId)
          : undefined;
        const tag = owner ? `${owner.name ?? owner.id} (${owner.role ?? 'no-role'})` : 'no-owner';
        return `  ${task.taskId.slice(0, 12)}  ${task.status.padEnd(8)} ${tag}  ${(task.description ?? '').slice(0, 60)}`;
      }),
      'Run `/fleet retry <taskId>` or `/fleet retry all` to re-assign.',
    ].join('\n');
  }
  const targets =
    taskId === 'all'
      ? interrupted
      : interrupted.filter((task) => task.taskId === taskId || task.taskId.startsWith(taskId));
  if (targets.length === 0) return `No interrupted task matched "${taskId}".`;
  const results: string[] = [];
  for (const task of targets) {
    const owner = task.subagentId
      ? prior.subagents.find((subagent) => subagent.id === task.subagentId)
      : undefined;
    if (!owner) {
      results.push(`  - ${task.taskId.slice(0, 12)}: no owner record, skipped.`);
      continue;
    }
    const rosterConfig = owner.role ? FLEET_ROSTER[owner.role] : undefined;
    const config = rosterConfig
      ? { ...rosterConfig }
      : {
          name: owner.name ?? owner.id,
          role: owner.role,
          provider: owner.provider,
          model: owner.model,
        };
    try {
      const subagentId = await director.spawn(config);
      const newTaskId = await director.assign({
        id: '',
        description: task.description ?? '(no description)',
        subagentId,
      });
      results.push(
        `  ${color.green('✓')} ${task.taskId.slice(0, 12)} → re-spawned ${subagentId.slice(0, 12)} (task ${newTaskId.slice(0, 12)})`,
      );
    } catch (error) {
      results.push(
        `  ${color.red('✗')} ${task.taskId.slice(0, 12)} → ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return [`Retried ${targets.length} task${targets.length === 1 ? '' : 's'}:`, ...results].join(
    '\n',
  );
}

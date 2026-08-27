import {
  type ACPProgressEvent,
  type AcpAgentCommandOverrides,
  defaultPermissionPolicy,
  EnsembleRegistry,
  probeAcpAgents,
  renderAcpBenchText,
  renderEnsembleText,
  resolveAcpAgentCommand,
  runAcpBench,
  runEnsemble,
  runOneAcpTask,
} from '@wrongstack/acp';
import type { SlashCommand } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  type LoadedAcpRegistry,
  loadCachedAcpRegistry,
  refreshAcpRegistry,
} from '../acp-registry-cache.js';
import type { SlashCommandContext } from './command-context.js';

/**
 * /acp — discover and drive the ACP-supporting coding CLIs installed on this
 * machine (Claude Code, Codex CLI, Gemini CLI, OpenCode, …) from inside the
 * WrongStack interface. These external agents run as subprocesses using THEIR
 * OWN login, so you exploit them without spending API credits here.
 *
 *   /acp                         list detected agents (✓ installed / ✗ missing)
 *   /acp <agent-id> <task>       run a task on one agent (inline, streamed)
 *   /acp <agent-id> --bg <task>  run it as a background fleet subagent
 *   /acp parallel <csv> <task>   fan a task out to several agents at once
 *   /acp probe [csv]             handshake-test agents (what actually works)
 *   /acp bench [csv] [--fs]      end-to-end verify each agent + graded report
 *   /acp sync                    pull the official agentclientprotocol/registry
 *   /acp help
 *
 * The agent list comes from the official registry
 * (https://github.com/agentclientprotocol/registry) once synced — cached
 * locally and merged over the bundled offline catalog.
 */
export function buildAcpCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'acp',
    category: 'Agent',
    description:
      'Discover and assign tasks to installed ACP coding agents (claude-code, codex-cli, gemini-cli, …).',
    argsHint: '[list | probe | <agent-id> [--bg] <task> | parallel <csv> <task>]',
    help: [
      'Use the ACP-supporting CLIs already installed on this machine as',
      'subagents — they run with their own login, so no API key is spent here.',
      '',
      'Usage:',
      '  /acp                          List detected agents (✓ installed / ✗ missing)',
      '  /acp <agent-id> <task>        Run a task on ONE agent, inline + streamed',
      '  /acp <agent-id> --bg <task>   Run it as a background fleet subagent (/agents)',
      '  /acp parallel <csv> <task>    Fan one task out to several agents at once',
      '  /acp probe [csv]              Handshake-test agents — shows what truly works',
      '  /acp bench [csv] [--fs]       End-to-end verify each agent + graded report',
      '  /acp sync                     Pull the official agentclientprotocol/registry',
      '  /acp help',
      '',
      'Examples:',
      '  /acp',
      '  /acp sync',
      '  /acp gemini-cli "explain src/agent.ts"',
      '  /acp claude-code --bg "refactor auth/session.ts and run the tests"',
      '  /acp parallel claude-code,gemini-cli,codex-cli "review this diff"',
      '  /acp probe',
      '',
      'If an agent is detected but `probe` shows it failing, its catalog entry',
      'likely needs a different ACP entry command. Override it in',
      '~/.wrongstack/profiles/<name>/config.json:',
      '  { "acp": { "agents": { "codex-cli": { "command": "codex", "args": ["acp"] } } } }',
    ].join('\n'),
    async run(args) {
      const trimmed = args.trim();
      const overrides = readOverrides(opts);
      if (trimmed === 'help') return { message: this.help ?? '' };
      if (trimmed === 'sync') return syncRegistry(opts);

      // Load the synced registry cache once per invocation (null if never synced).
      const live = opts.paths ? await loadCachedAcpRegistry(opts.paths) : null;

      // No args → list.
      if (!trimmed || trimmed === 'list') return listAgents(live);

      const spaceIdx = trimmed.search(/\s/);
      const head = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).trim();
      const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

      if (head === 'probe') return probeAgents(rest, overrides, live, opts);
      if (head === 'bench') return benchAgents(rest, overrides, live, opts);
      if (head === 'parallel') return parallelAgents(rest, overrides, live);

      // Otherwise `head` is an agent id and `rest` is the task (+ optional --bg).
      return runSingle(head, rest, overrides, live, opts);
    },
  };
}

/** Read user-config ACP overrides (never from in-project config — stripped). */
function readOverrides(opts: SlashCommandContext): AcpAgentCommandOverrides | undefined {
  try {
    return opts.configStore?.get()?.acp?.agents;
  } catch {
    return undefined;
  }
}

async function syncRegistry(opts: SlashCommandContext): Promise<{ message: string }> {
  if (!opts.paths) {
    return { message: 'Cannot sync: no cache directory available in this session.' };
  }
  try {
    const { count, location } = await refreshAcpRegistry(opts.paths);
    return {
      message: `Synced ${count} agents from the official ACP registry.\nCached at ${location}.\nRun \`/acp\` to see them, or \`/acp probe <id>\` to test one.`,
    };
  } catch (err) {
    return {
      message: `ACP registry sync failed: ${toErrorMessage(err)}\nThe bundled offline catalog is still available via \`/acp\`.`,
    };
  }
}

async function listAgents(live: LoadedAcpRegistry | null): Promise<{ message: string }> {
  // Probe only the bundled static catalog — those are real local installs.
  // npx/uvx-distributed registry agents can't be meaningfully "installed"
  // probed (the launcher is always present), so we list them separately.
  const detected = await new EnsembleRegistry().list();
  const installed = detected.filter((a) => a.installed);
  const missing = detected.filter((a) => !a.installed);
  const lines: string[] = ['Detected ACP agents (local installs):', ''];
  for (const a of installed) {
    const ver = a.version ? `  (${a.version.split('\n')[0]})` : '';
    lines.push(`  ✓ ${a.id.padEnd(16)} ${a.displayName}${ver}`);
  }
  for (const a of missing) {
    lines.push(`  ✗ ${a.id.padEnd(16)} ${a.displayName}  (${a.reason ?? 'not installed'})`);
  }
  lines.push('');
  lines.push(`${installed.length} of ${detected.length} bundled agents installed locally.`);

  if (live && live.agents.length > 0) {
    const localIds = new Set(detected.map((a) => a.id));
    const aliases: Record<string, string> = {
      'claude-acp': 'claude-code',
      gemini: 'gemini-cli',
      'codex-acp': 'codex-cli',
      'github-copilot-cli': 'copilot',
    };
    const extra = live.agents.filter(
      (a) => !localIds.has(a.id) && !localIds.has(aliases[a.id] ?? ''),
    );
    lines.push('');
    lines.push(
      `Synced registry: ${live.agents.length} agents available (use \`/acp <id> <task>\`).`,
    );
    if (extra.length > 0) {
      lines.push(`  more ids: ${extra.map((a) => a.id).join(', ')}`);
    }
  } else {
    lines.push('');
    lines.push('Run `/acp sync` to pull the full official registry (37+ agents).');
  }
  lines.push('Run `/acp <agent-id> <task>` to assign a task, or `/acp probe` to test handshakes.');
  return { message: lines.join('\n') };
}

async function probeAgents(
  csv: string,
  overrides: AcpAgentCommandOverrides | undefined,
  live: LoadedAcpRegistry | null,
  opts: SlashCommandContext,
): Promise<{ message: string }> {
  // Default to the installed set; an explicit csv overrides it.
  let ids: string[];
  if (csv) {
    ids = dedup(
      csv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } else {
    const detected = await new EnsembleRegistry().list();
    ids = detected.filter((a) => a.installed).map((a) => a.id);
  }
  if (ids.length === 0) {
    return { message: 'No installed agents to probe. Run `/acp` to see what is detected.' };
  }

  opts.renderer.writeInfo(
    `Probing ${ids.length} agent(s)… (npx-based agents may download on first run)\n`,
  );
  const liveById = live?.byId;
  // BOUNDED concurrency: spawning every agent at once (incl. first-run npx
  // downloads) starves local agents' handshake — they then falsely time out.
  const results = await probeAcpAgents({
    agentIds: ids,
    resolveCmd: (id) => resolveAcpAgentCommand(id, overrides, liveById),
    projectRoot: opts.projectRoot,
    onProgress: (id, r) => opts.renderer.writeInfo(`  ${r.ok ? '✓' : '✗'} ${id} (${r.ms}ms)\n`),
  });

  const lines: string[] = ['ACP handshake probe:', ''];
  for (const r of results) {
    if (r.ok) {
      const name = r.agentInfo?.name ? ` — ${r.agentInfo.name} ${r.agentInfo.version}` : '';
      lines.push(`  ✓ ${r.id.padEnd(16)} ok  ${r.ms}ms${name}`);
    } else {
      lines.push(`  ✗ ${r.id.padEnd(16)} ${r.error ?? 'failed'}  (${r.ms}ms)`);
    }
  }
  const ok = results.filter((r) => r.ok).length;
  lines.push('');
  lines.push(`${ok} of ${results.length} agents completed the ACP handshake.`);
  lines.push('A ✗ usually means the catalog entry needs a different command — override it');
  lines.push('in the active profile config under acp.agents.');
  return { message: lines.join('\n') };
}

async function benchAgents(
  rest: string,
  overrides: AcpAgentCommandOverrides | undefined,
  live: LoadedAcpRegistry | null,
  opts: SlashCommandContext,
): Promise<{ message: string }> {
  const tokens = rest.split(/\s+/).filter(Boolean);
  const checkFs = tokens.includes('--fs');
  const csv = tokens.filter((t) => t !== '--fs').join(' ');

  let ids: string[];
  if (csv) {
    ids = dedup(
      csv
        .split(',')
        .flatMap((s) => s.split(/\s+/))
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } else {
    const detected = await new EnsembleRegistry().list();
    ids = detected.filter((a) => a.installed).map((a) => a.id);
  }
  if (ids.length === 0) {
    return {
      message:
        'No installed agents to bench. Run `/acp` to see what is detected, or pass ids: `/acp bench gemini-cli,codex-cli`.',
    };
  }

  opts.renderer.writeInfo(
    `Benching ${ids.length} agent(s)${checkFs ? ' (with fs check)' : ''}: ${ids.join(', ')}…\n`,
  );
  const liveById = live?.byId;
  const result = await runAcpBench({
    agentIds: ids,
    resolveCmd: (id) => resolveAcpAgentCommand(id, overrides, liveById),
    projectRoot: opts.projectRoot,
    checkFs,
    onProgress: (agentId, phase, r) => {
      if (phase === 'start') opts.renderer.writeInfo(`  ▸ ${agentId}…\n`);
      else if (r) opts.renderer.writeInfo(`  ↳ ${agentId}: ${r.status}\n`);
    },
  });
  return { message: renderAcpBenchText(result) };
}

async function parallelAgents(
  rest: string,
  overrides: AcpAgentCommandOverrides | undefined,
  live: LoadedAcpRegistry | null,
): Promise<{ message: string }> {
  const spaceIdx = rest.search(/\s/);
  if (spaceIdx === -1) {
    return {
      message:
        'Usage: /acp parallel <agent-ids-csv> <task>\nExample: /acp parallel claude-code,gemini-cli "review this diff"',
    };
  }
  const agentIds = rest.slice(0, spaceIdx);
  const task = stripQuotes(rest.slice(spaceIdx + 1).trim());
  if (!task) return { message: 'Task description is required.' };
  const liveById = live?.byId;
  try {
    const result = await runEnsemble({
      agentIds,
      task,
      resolveCmd: (id) => resolveAcpAgentCommand(id, overrides, liveById),
    });
    return { message: renderEnsembleText(result) };
  } catch (err) {
    return { message: `Ensemble failed: ${toErrorMessage(err)}` };
  }
}

async function runSingle(
  agentId: string,
  rest: string,
  overrides: AcpAgentCommandOverrides | undefined,
  live: LoadedAcpRegistry | null,
  opts: SlashCommandContext,
): Promise<{ message: string }> {
  // Detect a `--bg` flag anywhere in the remaining tokens.
  const tokens = rest.split(/\s+/).filter(Boolean);
  const bg = tokens.includes('--bg');
  const task = stripQuotes(
    tokens
      .filter((t) => t !== '--bg')
      .join(' ')
      .trim(),
  );
  if (!task) {
    return {
      message: `Usage: /acp ${agentId} <task>  (add --bg to run in the background)\nTask description is required.`,
    };
  }

  const cmd = resolveAcpAgentCommand(agentId, overrides, live?.byId);
  if (!cmd) {
    return {
      message: `Unknown ACP agent: ${agentId}\nRun \`/acp\` to see available agents.`,
    };
  }

  // Background path: dispatch as a fleet subagent (provider:'acp'), if the
  // session has multi-agent wired. Falls back to a clear message otherwise.
  if (bg) {
    if (!opts.onSpawn) {
      return {
        message: 'Background mode needs the fleet (director). Director Mode is always active.',
      };
    }
    try {
      const summary = await opts.onSpawn(task, { provider: 'acp', name: agentId });
      return { message: `Dispatched '${agentId}' as a background ACP subagent.\n${summary}` };
    } catch (err) {
      return { message: `Background spawn failed: ${toErrorMessage(err)}` };
    }
  }

  // Inline path: run now, stream progress to the UI, return the result.
  opts.renderer.writeInfo(`Running task on '${agentId}'…\n`);
  try {
    const result = await runOneAcpTask({
      command: cmd.command,
      ...(cmd.args !== undefined ? { args: cmd.args } : {}),
      ...(cmd.env !== undefined ? { env: cmd.env } : {}),
      role: agentId,
      task,
      cwd: opts.cwd,
      projectRoot: opts.projectRoot,
      sessionId: opts.context?.eventSessionId(),
      permissionPolicy: defaultPermissionPolicy,
      onProgress: (event) => {
        const line = formatProgress(event);
        if (line) opts.renderer.writeInfo(`  ${line}\n`);
      },
    });
    const body = result.result && result.result.length > 0 ? result.result : '(no text output)';
    return {
      message: `=== ${agentId} ===\n${body}\n\n[${agentId}] done — iterations=${result.iterations} toolCalls=${result.toolCalls}`,
    };
  } catch (err) {
    const e = err as { kind?: string; message?: string };
    const detail = e.kind ? `[${e.kind}] ` : '';
    const message = e.message ?? toErrorMessage(err);
    return { message: `ACP agent '${agentId}' failed: ${detail}${message}` };
  }
}

/** Render one streamed ACP progress event as a compact one-line summary. */
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

function dedup(items: string[]): string[] {
  return [...new Set(items)];
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' || first === "'") && first === last) return s.slice(1, -1);
  return s;
}

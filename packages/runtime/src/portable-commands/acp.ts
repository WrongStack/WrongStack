import {
  type ACPProgressEvent,
  type AcpAgentCommandOverrides,
  type AcpSessionTarget,
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
import type { SlashCommand } from '@wrongstack/contracts/types';
import type { AcpChildSession } from '@wrongstack/contracts/types/acp-runtime';
import { sessionAcpRuntime } from '@wrongstack/coordination';
import { sanitizeTerminalPreview, stripAnsi, toErrorMessage } from '@wrongstack/core/utils';
import {
  formatAcpAgentList,
  formatAcpProbeCapabilities,
  installedAcpAgentIds,
} from './acp-agent-list.js';
import { acpCompanionCommand } from './acp-companions.js';
import { acpNativeCommand } from './acp-native-commands.js';
import {
  discoverAcpRegistry,
  type LoadedAcpRegistry,
  loadCachedAcpRegistry,
  refreshAcpRegistry,
} from './acp-registry-cache.js';
import { configureAcpRuntime } from './acp-runtime-config.js';
import { formatAcpSessions, listAcpSessions } from './acp-sessions.js';
import { askingSessionId } from './fleet.js';
import type { AcpCommandHost } from './host.js';

/**
 * /acp — discover and drive the ACP-supporting coding CLIs installed on this
 * machine (Claude Code, Codex CLI, Gemini CLI, OpenCode, …) from inside the
 * WrongStack interface. These external agents run as subprocesses using THEIR
 * OWN login, so you exploit them without spending API credits here.
 *
 *   /acp                         discover current registry and local agents
 *   /acp <agent-id> <task>       run a task on one agent (inline, streamed)
 *   /acp <agent-id> --bg <task>  run it as a background fleet subagent
 *   /acp parallel <csv> <task>   fan a task out to several agents at once
 *   /acp parallel <csv> --bg <task>  same, but each agent runs as a background
 *                             fleet subagent — live progress shows in /agents,
 *                             the TUI fleet panel and the WebUI Agents panel
 *   /acp probe [csv]             handshake-test agents (what actually works)
 *   /acp bench [csv] [--fs]      end-to-end verify each agent + graded report
 *   /acp sync                    pull the official agentclientprotocol/registry
 *   /acp help
 *
 * The agent list comes from the official registry
 * (https://github.com/agentclientprotocol/registry) once synced — cached
 * locally and merged over the bundled offline catalog.
 */
export function buildAcpCommand(opts: AcpCommandHost): SlashCommand {
  return {
    name: 'acp',
    category: 'Agent',
    description:
      'Discover and assign tasks to installed ACP coding agents (claude-code, codex-cli, gemini-cli, …).',
    argsHint:
      '[list | commands | command | sessions | continue | fork | companion | config | mode | plan | children | probe | <agent-id> [--bg] <task>]',
    help: [
      'Use the ACP-supporting CLIs already installed on this machine as',
      'subagents — they run with their own login, so no API key is spent here.',
      '',
      'Usage:',
      '  /acp config                   Read the active ACP leader’s live settings',
      '  /acp config <agent>           Read the agent model/effort selectors',
      '  /acp config <agent> <id> <value>  Apply on the active leader and save the session setting',
      '  /acp config <agent> reset     Clear this session override',
      '  Add --lane=1 or --role=reviewer to configure a lane/role instead.',
      '  /acp mode [selector] [value]  Read or change the active ACP leader’s mode',
      '  /acp plan                     Show the active ACP leader’s latest plans',
      '  /acp children [session-id]    Inspect the active agent’s child sessions',
      '  /acp                          Discover current registry and local agents',
      '  /acp commands                 List the active ACP leader’s native commands',
      '  /acp command <name> [args]    Run a native command in this conversation',
      '  /acp sessions <id> [cursor]     List the current project’s sessions',
      '  /acp continue <id> <session> <task>  Send a turn to an existing session',
      '  /acp fork <id> <session> <task>      Continue a copy of an existing session',
      '  /acp companion <id> <task>     Start or talk to a companion in this conversation',
      '  /acp companion                 List companions linked to this conversation',
      '  /acp companion forget <id>     Unlink a companion',
      '  /acp <agent-id> <task>        Run a task on ONE agent, inline + streamed',
      '  /acp <agent-id> --bg <task>   Run it as a background fleet subagent (/agents)',
      '  /acp parallel <csv> <task>    Fan one task out to several agents at once',
      '  /acp parallel <csv> --bg <task>  Same, as background fleet subagents',
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
      '  /acp parallel claude-code,gemini-cli --bg "review this diff"',
      '  /acp probe',
      '',
      'If an agent is detected but `probe` shows it failing, its catalog entry',
      'likely needs a different ACP entry command. Override it in',
      '~/.wrongstack/profiles/<name>/config.json:',
      '  { "acp": { "agents": { "codex-cli": { "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] } } } }',
    ].join('\n'),
    async run(args, ctx) {
      const trimmed = args.trim();
      const [head, rest] = splitFirstWord(trimmed);
      if (head === 'commands' || head === 'command') return acpNativeCommand(head, rest, ctx);
      if (head === 'config') return configureAcpRuntime(rest, opts, ctx);
      if (head === 'mode') return nativeModeCommand(rest, ctx);
      if (head === 'plan') return nativePlanCommand(rest, ctx);
      if (head === 'children') return nativeChildrenCommand(rest, ctx);
      const overrides = readOverrides(opts);
      if (trimmed === 'help') return { message: this.help ?? '' };
      if (trimmed === 'sync') return syncRegistry(opts);
      if (!trimmed || trimmed === 'list') {
        const [detected, live] = await Promise.all([
          new EnsembleRegistry().list(),
          opts.paths ? discoverAcpRegistry(opts.paths) : null,
        ]);
        return { message: formatAcpAgentList({ live, detected, overrides }) };
      }

      // Load the synced registry cache once per invocation (null if never synced).
      const live = opts.paths ? await loadCachedAcpRegistry(opts.paths) : null;

      if (head === 'sessions') {
        const [agentId, remaining] = splitFirstWord(rest);
        const cursor = remaining ? parseSessionArgument(remaining) : undefined;
        if (!agentId || (remaining && (!cursor || cursor[1]))) {
          return { message: 'Usage: /acp sessions <agent-id> [cursor]' };
        }
        try {
          const page = await listAcpSessions({
            agentId,
            cursor: cursor?.[0] || undefined,
            projectRoot: opts.projectRoot,
            overrides,
            live: live?.byId,
          });
          return { message: formatAcpSessions(page) };
        } catch (error) {
          return { message: `ACP session listing failed: ${toErrorMessage(error)}` };
        }
      }
      if (head === 'probe') return probeAgents(rest, overrides, live, opts);
      if (head === 'bench') return benchAgents(rest, overrides, live, opts);
      const originSessionId = askingSessionId(ctx);
      if (head === 'companion') {
        return acpCompanionCommand(rest, ctx, (agentId, task, sessionTarget, remember) =>
          runSingle(
            agentId,
            task,
            overrides,
            live,
            opts,
            ctx?.eventSessionId?.(),
            originSessionId,
            { sessionTarget, remember },
          ),
        );
      }
      if (head === 'parallel') return parallelAgents(rest, overrides, live, opts, originSessionId);
      if (head === 'continue' || head === 'fork') {
        const [agentId, remaining] = splitFirstWord(rest);
        const [id, task] = parseSessionArgument(remaining) ?? ['', ''];
        if (!agentId || !id || !stripQuotes(task)) {
          return { message: `Usage: /acp ${head} <agent-id> <session-id> <task>` };
        }
        return runSingle(
          agentId,
          task,
          overrides,
          live,
          opts,
          ctx?.eventSessionId?.(),
          originSessionId,
          {
            sessionTarget: { action: head === 'continue' ? 'resume' : 'fork', sessionId: id },
          },
        );
      }

      // Otherwise `head` is an agent id and `rest` is the task (+ optional --bg).
      return runSingle(head, rest, overrides, live, opts, ctx?.eventSessionId?.(), originSessionId);
    },
  };
}

async function nativeChildrenCommand(
  input: string,
  ctx: Parameters<SlashCommand['run']>[1],
): Promise<{ message: string }> {
  if (!ctx?.provider?.listNativeChildren || !ctx.session?.id) {
    return { message: 'Select an ACP session leader in this conversation first.' };
  }
  const target = input ? parseSessionArgument(input) : undefined;
  if (input && (!target?.[0] || target[1])) return { message: 'Usage: /acp children [session-id]' };
  try {
    const children = await ctx.provider.listNativeChildren(ctx.model, ctx.session.id);
    if (target) {
      const child = children.find((entry) => entry.id === target[0]);
      if (!child) return { message: 'This conversation has no ACP child session with that ID.' };
      const message = [
        describeChild(child),
        `Parent session ${JSON.stringify(child.parentId)}`,
        ...(child.description ? [child.description] : []),
        ...(child.activity ? [`Last tool: ${child.activity}`] : []),
        ...(child.message
          ? [
              `Message from ${child.message.senderId ? JSON.stringify(child.message.senderId) : 'another session'}\n${child.message.text}`,
            ]
          : []),
        ...(child.output ? [`Recent output\n${child.output}`] : []),
      ].join('\n\n');
      return {
        message: sanitizeTerminalPreview(message, { maxChars: 12_000, maxLines: 200 }).text,
      };
    }
    if (!children.length)
      return { message: 'This conversation has no announced ACP child sessions.' };
    const byParent = Map.groupBy(children, (child) => child.parentId);
    const ids = new Set(children.map((child) => child.id));
    const lines: string[] = [];
    const visit = (child: AcpChildSession, level: number): void => {
      lines.push(`${'  '.repeat(Math.min(level, 10))}${describeChild(child)}`);
      for (const nested of byParent.get(child.id) ?? []) visit(nested, level + 1);
    };
    for (const child of children) {
      if (!ids.has(child.parentId)) visit(child, 0);
    }
    return {
      message: sanitizeTerminalPreview(
        [
          `ACP child sessions from ${ctx.model}`,
          ...lines,
          '',
          'Use /acp children <session-id> to inspect one.',
        ].join('\n'),
        { maxChars: 64_000, maxLines: 300 },
      ).text,
    };
  } catch (error) {
    return { message: `ACP child sessions failed: ${toErrorMessage(error)}` };
  }
}

function describeChild(child: AcpChildSession): string {
  return `${child.title ?? 'Subagent'} ${JSON.stringify(child.id)} — ${child.state}${child.stopReason ? ` (${child.stopReason})` : ''}`;
}

async function nativePlanCommand(
  input: string,
  ctx: Parameters<SlashCommand['run']>[1],
): Promise<{ message: string }> {
  if (input) return { message: 'Usage: /acp plan' };
  if (!ctx?.provider?.listNativePlans || !ctx.session?.id) {
    return { message: 'Select an ACP session leader in this conversation first.' };
  }
  try {
    const plans = await ctx.provider.listNativePlans(ctx.model, ctx.session.id);
    const blocks = plans.flatMap((plan) => {
      if (plan.type === 'markdown')
        return plan.content.trim() ? [`Plan ${plan.planId}\n${plan.content}`] : [];
      if (!plan.entries.length) return [];
      const steps = plan.entries.map((entry) => {
        const status =
          entry.status === 'completed'
            ? 'Done'
            : entry.status === 'in_progress'
              ? 'In progress'
              : 'Pending';
        return `  - ${status}: ${entry.content}`;
      });
      return [
        [plan.planId === null ? 'Checklist' : `Checklist ${plan.planId}`, ...steps].join('\n'),
      ];
    });
    if (blocks.length === 0) return { message: 'This ACP conversation has no active plan yet.' };
    const preview = sanitizeTerminalPreview(
      [`ACP plans from ${ctx.model}`, ...blocks].join('\n\n'),
      { maxChars: 64_000, maxLines: 1_000 },
    );
    return {
      message: preview.text + (preview.truncated ? '\n\nAdditional plan content omitted.' : ''),
    };
  } catch (error) {
    return { message: `ACP plan failed: ${toErrorMessage(error)}` };
  }
}

async function nativeModeCommand(
  input: string,
  ctx: Parameters<SlashCommand['run']>[1],
): Promise<{ message: string }> {
  if (!ctx?.provider?.configureNativeMode || !ctx.session?.id) {
    return { message: 'Select an ACP session leader in this conversation first.' };
  }
  const first = input ? parseSessionArgument(input) : undefined;
  const second = first?.[1] ? parseSessionArgument(first[1]) : undefined;
  if (input && (!first?.[0] || (first[1] && (!second?.[0] || second[1])))) {
    return { message: 'Usage: /acp mode [selector] [value]' };
  }
  try {
    const modes = await ctx.provider.configureNativeMode(
      ctx.model,
      ctx.session.id,
      first ? (second ? { optionId: first[0], value: second[0] } : { value: first[0] }) : undefined,
    );
    const display = (value: string) => stripAnsi(value).replace(/\p{Cc}/gu, ' ');
    return {
      message: [
        `ACP modes for ${display(ctx.model)}`,
        ...modes.flatMap((mode) => [
          `${display(mode.id)}: ${display(mode.currentValue || 'unknown')}`,
          `  Agent offers: ${mode.options.map((option) => display(option.value)).join(' | ')}`,
          `  Selectable: ${mode.selectableValues.map(display).join(' | ') || 'view only'}`,
        ]),
        ...(!modes.length ? ['This agent has not advertised session modes.'] : []),
      ].join('\n'),
    };
  } catch (error) {
    return { message: `ACP mode failed: ${toErrorMessage(error)}` };
  }
}

/** The `acp.bridge` config: what WrongStack hands a delegated worker. */
function readBridgeConfig(opts: AcpCommandHost) {
  try {
    return opts.configStore?.get()?.acp?.bridge;
  } catch {
    return undefined;
  }
}

/** Read user-config ACP overrides (never from in-project config — stripped). */
function readOverrides(opts: AcpCommandHost): AcpAgentCommandOverrides | undefined {
  try {
    return opts.configStore?.get()?.acp?.agents;
  } catch {
    return undefined;
  }
}

async function syncRegistry(opts: AcpCommandHost): Promise<{ message: string }> {
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

async function probeAgents(
  csv: string,
  overrides: AcpAgentCommandOverrides | undefined,
  live: LoadedAcpRegistry | null,
  opts: AcpCommandHost,
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
    ids = installedAcpAgentIds(detected, live);
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
      lines.push(`  ✓ ${r.id.padEnd(16)} ok  ${r.ms}ms${name}${formatAcpProbeCapabilities(r)}`);
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
  opts: AcpCommandHost,
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
    ids = installedAcpAgentIds(detected, live);
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
  opts: AcpCommandHost,
  originSessionId?: string | undefined,
): Promise<{ message: string }> {
  // Detect a `--bg` flag anywhere in the tokens; the rest is `<csv> <task>`.
  const tokens = rest.split(/\s+/).filter(Boolean);
  const bg = tokens.includes('--bg');
  const withoutFlag = tokens.filter((t) => t !== '--bg').join(' ');
  const spaceIdx = withoutFlag.search(/\s/);
  if (spaceIdx === -1) {
    return {
      message:
        'Usage: /acp parallel <agent-ids-csv> [--bg] <task>\nExample: /acp parallel claude-code,gemini-cli --bg "review this diff"',
    };
  }
  const idsCsv = withoutFlag.slice(0, spaceIdx).trim();
  const agentIds = dedup(
    idsCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const task = stripQuotes(withoutFlag.slice(spaceIdx + 1).trim());
  if (agentIds.length === 0 || !task) {
    return { message: 'Task description is required.' };
  }
  const liveById = live?.byId;

  // Background path: dispatch every known agent as its own fleet subagent
  // (provider:'acp') and return immediately. Live progress for each subagent
  // streams through the same fleet/host buses as any other background worker.
  if (bg || (opts.inlineAcpRuns === false && opts.onSpawn)) {
    if (!opts.onSpawn) {
      return {
        message: 'Background mode needs the fleet (director). Director Mode is always active.',
      };
    }
    const dispatched: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of agentIds) {
      if (!resolveAcpAgentCommand(id, overrides, liveById)) {
        skipped.push({ id, reason: 'unknown agent' });
        continue;
      }
      try {
        const summary = await opts.onSpawn(task, {
          provider: 'acp',
          name: id,
          ...(originSessionId ? { originSessionId } : {}),
        });
        dispatched.push(`  • ${id}: ${summary}`);
      } catch (err) {
        skipped.push({ id, reason: toErrorMessage(err) });
      }
    }
    const lines = [
      dispatched.length === 0
        ? 'No ACP agents dispatched.'
        : `Dispatched ${dispatched.length} ACP agent${dispatched.length === 1 ? '' : 's'} as background subagents.`,
      ...dispatched,
    ];
    if (skipped.length > 0) {
      lines.push(
        `Skipped ${skipped.length}: ${skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}`,
      );
    }
    lines.push(
      'Live progress is visible in /agents, the TUI fleet panel and the WebUI Agents panel.',
    );
    return { message: lines.join('\n') };
  }

  try {
    const result = await runEnsemble({
      agentIds: idsCsv,
      task,
      ...(originSessionId ? { sessionId: originSessionId } : {}),
      resolveCmd: (id) => {
        const cmd = resolveAcpAgentCommand(id, overrides, liveById);
        if (!cmd) return null;
        const permissionPolicy = opts.acpPermissionPolicy?.(id);
        return {
          ...cmd,
          cwd: opts.projectRoot,
          projectRoot: opts.projectRoot,
          sessionSetup: opts.acpSessionSetup?.(id, opts.projectRoot, readBridgeConfig(opts)),
          ...(permissionPolicy ? { permissionPolicy } : {}),
        };
      },
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
  opts: AcpCommandHost,
  sessionId: string | undefined,
  originSessionId?: string | undefined,
  turn?: {
    sessionTarget?: AcpSessionTarget | undefined;
    remember?: ((sessionId: string) => void) | undefined;
  },
): Promise<{ message: string }> {
  // Detect a `--bg` flag anywhere in the remaining tokens.
  const tokens = rest.split(/\s+/).filter(Boolean);
  const bg = !turn && tokens.includes('--bg');
  const task = stripQuotes(
    turn
      ? rest
      : tokens
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
  // A host with no terminal to stream into runs every task this way: the
  // agents view shows its progress, where inline it would show nothing until
  // the agent finished.
  if (!turn && (bg || (opts.inlineAcpRuns === false && opts.onSpawn))) {
    if (!opts.onSpawn) {
      return {
        message: 'Background mode needs the fleet (director). Director Mode is always active.',
      };
    }
    try {
      const summary = await opts.onSpawn(task, {
        provider: 'acp',
        name: agentId,
        ...(originSessionId ? { originSessionId } : {}),
      });
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
      sessionId,
      ...(turn?.sessionTarget ? { sessionTarget: turn.sessionTarget } : {}),
      permissionPolicy: opts.acpPermissionPolicy?.(agentId) ?? defaultPermissionPolicy,
      runtimeValues: {
        ...opts.configStore?.get().modelRuntime?.acp?.[agentId],
        ...sessionAcpRuntime(originSessionId)[agentId],
      },
      sessionSetup: opts.acpSessionSetup?.(agentId, opts.projectRoot, readBridgeConfig(opts)),
      onProgress: (event) => {
        const line = formatProgress(event);
        if (line) opts.renderer.writeInfo(`  ${line}\n`);
      },
    });
    if (result.agentSessionId) turn?.remember?.(result.agentSessionId);
    const body = result.result && result.result.length > 0 ? result.result : '(no text output)';
    const reference = result.agentSessionId
      ? `\nACP session: ${JSON.stringify(result.agentSessionId)}`
      : '';
    return {
      message: `=== ${agentId} ===\n${body}\n\n[${agentId}] done — iterations=${result.iterations} toolCalls=${result.toolCalls}${reference}`,
    };
  } catch (err) {
    const e = err as { kind?: string; message?: string };
    const detail = e.kind ? `[${e.kind}] ` : '';
    const message = e.message ?? toErrorMessage(err);
    return { message: `ACP agent '${agentId}' failed: ${detail}${message}` };
  }
}

function splitFirstWord(input: string): [string, string] {
  const boundary = input.search(/\s/);
  return boundary < 0 ? [input, ''] : [input.slice(0, boundary), input.slice(boundary).trimStart()];
}

/** Parse the quoted opaque IDs and cursors emitted by the session commands. */
function parseSessionArgument(input: string): [string, string] | undefined {
  const match = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+)(?=\s|$)/u.exec(input);
  if (!match) return undefined;
  const raw = match[0];
  try {
    const value = raw.startsWith('"') ? (JSON.parse(raw) as string) : stripQuotes(raw);
    return [value, input.slice(raw.length).trimStart()];
  } catch {
    return undefined;
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

/** Shared `/acp` and `wstack acp list` discovery output. */
import {
  type ACPAgentDescriptor,
  type AcpAgentCommandOverrides,
  type AcpProbeResult,
  acpCommandOnPath,
  canonicalAcpAgentId,
  type DetectedAgent,
  resolveAcpAgentCommand,
} from '@wrongstack/acp';
import type { LoadedAcpRegistry } from './acp-registry-cache.js';

function distKind(command: string): 'npx' | 'uvx' | 'local' {
  if (command === 'npx') return 'npx';
  if (command === 'uvx') return 'uvx';
  return 'local';
}

function isLocallyDetected(agent: DetectedAgent | undefined): boolean {
  return Boolean(
    agent?.installed || (agent?.probe?.command && acpCommandOnPath(agent.probe.command)),
  );
}

/** Include locally available registry-only agents in default probe and bench runs. */
export function installedAcpAgentIds(
  detected: readonly DetectedAgent[],
  live: LoadedAcpRegistry | null,
): string[] {
  const quarantined = new Set(
    (live?.agents ?? [])
      .filter((agent) => agent.registry?.quarantineReason)
      .map((agent) => canonicalAcpAgentId(agent.id)),
  );
  const ids = new Set(
    detected
      .filter((agent) => isLocallyDetected(agent) && !quarantined.has(agent.id))
      .map((agent) => agent.id),
  );
  for (const agent of live?.agents ?? []) {
    const id = canonicalAcpAgentId(agent.id);
    if (
      !quarantined.has(id) &&
      distKind(agent.acp.command) === 'local' &&
      acpCommandOnPath(agent.acp.command)
    ) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function formatAcpProbeCapabilities(probe: AcpProbeResult): string {
  const caps = probe.capabilities;
  const names = [
    ...(caps?.loadSession ? ['load'] : []),
    ...(['resume', 'fork', 'list', 'close', 'delete', 'additionalDirectories'] as const).filter(
      (name) => caps?.sessionCapabilities?.[name],
    ),
    ...(caps?.promptCapabilities?.image ? ['image'] : []),
    ...(caps?.promptCapabilities?.audio ? ['audio'] : []),
    ...(caps?.promptCapabilities?.embeddedContext ? ['embedded context'] : []),
    ...(caps?.mcpCapabilities?.http ? ['MCP HTTP'] : []),
    ...(caps?.mcpCapabilities?.sse ? ['MCP SSE'] : []),
    ...(probe.steering ? ['steer'] : []),
  ];
  return names.length > 0 ? ` [${names.join(', ')}]` : '';
}

function formatRegistryRow(
  agent: ACPAgentDescriptor,
  alias: string | undefined,
  local: DetectedAgent | undefined,
  idWidth: number,
  configured: boolean,
  command: string,
  args: readonly string[],
): { rank: number; text: string } {
  const kind = distKind(command);
  const aliasBit = alias ? `  (also ${alias})` : '';
  const version = agent.registry?.version ? `  [registry ${agent.registry.version}]` : '';
  const label = `${agent.id.padEnd(idWidth)}  ${agent.displayName}${aliasBit}${version}`;
  if (agent.registry?.quarantineReason && !configured) {
    return {
      rank: 3,
      text: `  ✗ ${label}  (upstream quarantine: ${agent.registry.quarantineReason})`,
    };
  }
  if (configured) return { rank: 0, text: `  ✓ ${label}  configured` };
  if (kind === 'local') {
    if (isLocallyDetected(local) || acpCommandOnPath(command)) {
      const ver = local?.version?.split('\n')[0]?.trim();
      return { rank: 0, text: `  ✓ ${label}  local CLI${ver ? ` ${ver}` : ''}` };
    }
    const archive = agent.registry?.archive;
    const install = archive ? `install binary from ${archive}` : `missing ${command}`;
    return { rank: 2, text: `  ✗ ${label}  (${install})` };
  }
  const pkg = args.find((a) => a !== '-y' && !a.startsWith('--'));
  if (!acpCommandOnPath(kind)) {
    return { rank: 2, text: `  ✗ ${label}  (missing ${kind} launcher)` };
  }
  const installed = isLocallyDetected(local);
  return {
    rank: installed ? 0 : 1,
    text: `  ▸ ${label}  ${installed ? 'local CLI detected · ' : ''}on demand via ${kind}${pkg ? ` ${pkg}` : ''}`,
  };
}

export function formatAcpAgentList(opts: {
  live: LoadedAcpRegistry | null;
  detected: readonly DetectedAgent[];
  overrides?: AcpAgentCommandOverrides | undefined;
}): string {
  const { live, detected, overrides } = opts;
  const detectedById = new Map(detected.map((d) => [d.id, d]));
  const configured = new Set(Object.keys(overrides ?? {}).map(canonicalAcpAgentId));

  if (live && live.agents.length > 0) {
    const when = live.fetchedAt ? live.fetchedAt.slice(0, 19).replace('T', ' ') : 'locally';
    const rows = live.agents.filter((a) => a.id !== 'opencode-v2' || !live.byId['opencode']);
    const idWidth = Math.max(16, ...rows.map((a) => a.id.length));
    const lines: string[] = [
      `Official ACP registry — ${rows.length} agents (synced ${when}).`,
      'ACP coding agents can lead a session or run as WrongStack subagents.',
      '✓ local or configured · ▸ package launcher · ✗ setup required or quarantined. Use /acp probe to verify ACP.',
      '',
    ];
    const rendered = rows.map((agent) => {
      const id = canonicalAcpAgentId(agent.id);
      const alias = id !== agent.id ? id : agent.id === 'opencode' ? 'opencode-v2' : undefined;
      const launch = resolveAcpAgentCommand(agent.id, overrides, live.byId) ?? agent.acp;
      const row = formatRegistryRow(
        agent,
        alias,
        detectedById.get(id) ?? detectedById.get(agent.id),
        idWidth,
        configured.has(id),
        launch.command,
        launch.args ?? [],
      );
      return { id: agent.id, ...row };
    });
    rendered.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
    lines.push(...rendered.map((row) => row.text));

    const listed = new Set(live.agents.map((agent) => canonicalAcpAgentId(agent.id)));
    const leftover = detected.filter((d) => !listed.has(d.id));
    const custom = [...configured].filter((id) => !listed.has(id) && !detectedById.has(id));
    if (leftover.length > 0 || custom.length > 0) {
      lines.push('');
      lines.push('Bundled extras and configured agents outside this registry snapshot');
      for (const d of leftover) {
        const installed = isLocallyDetected(d);
        const mark = installed || configured.has(d.id) ? '✓' : '✗';
        const extra = configured.has(d.id)
          ? 'configured'
          : installed
            ? (d.version?.split('\n')[0] ?? 'local CLI')
            : (d.reason ?? 'not installed');
        lines.push(`  ${mark} ${d.id.padEnd(16)}  ${d.displayName}  (${extra})`);
      }
      for (const id of custom) lines.push(`  ✓ ${id.padEnd(16)}  configured`);
    }
    lines.push('');
    lines.push(
      'Spawn: /acp <id> <task>   Background: /acp <id> --bg <task>   Probe: /acp probe <id>',
    );
    return lines.join('\n');
  }

  const installed = detected.filter(isLocallyDetected);
  const missing = detected.filter((a) => !isLocallyDetected(a));
  const lines: string[] = [
    'ACP coding agents — use as WrongStack subagents or session leaders.',
    'Bundled offline catalog (not the official registry).',
    'Run `/acp sync` to retry the official registry.',
    '',
  ];
  for (const a of installed) {
    const ver = a.version ? `  (${a.version.split('\n')[0]})` : '';
    lines.push(`  ✓ ${a.id.padEnd(16)} ${a.displayName}${ver}`);
  }
  for (const a of missing) {
    lines.push(
      configured.has(a.id)
        ? `  ✓ ${a.id.padEnd(16)} ${a.displayName}  (configured)`
        : `  ✗ ${a.id.padEnd(16)} ${a.displayName}  (${a.reason ?? 'not installed'})`,
    );
  }
  for (const id of configured) {
    if (!detectedById.has(id)) lines.push(`  ✓ ${id.padEnd(16)}  configured`);
  }
  lines.push('');
  lines.push(`${installed.length} of ${detected.length} bundled agents installed locally.`);
  return lines.join('\n');
}

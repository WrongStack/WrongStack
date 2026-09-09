/**
 * Shared `/acp` + `wstack acp list` renderer.
 *
 * After `sync`, the official registry is the list the user sees — not the
 * 13-entry bundled offline catalog (which still includes experimental ids
 * that are not in https://github.com/agentclientprotocol/registry).
 */
import { type ACPAgentDescriptor, type DetectedAgent, REGISTRY_ID_ALIASES } from '@wrongstack/acp';
import type { LoadedAcpRegistry } from './acp-registry-cache.js';

function reverseAliases(
  aliases: Readonly<Record<string, string>> = REGISTRY_ID_ALIASES,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ours, theirs] of Object.entries(aliases)) {
    if (ours !== theirs) out[theirs] = ours;
  }
  return out;
}

function distKind(command: string): 'npx' | 'uvx' | 'local' {
  if (command === 'npx') return 'npx';
  if (command === 'uvx') return 'uvx';
  return 'local';
}

function localProbe(
  registryId: string,
  alias: string | undefined,
  detectedById: Map<string, DetectedAgent>,
): DetectedAgent | undefined {
  return detectedById.get(registryId) ?? (alias ? detectedById.get(alias) : undefined);
}

function formatRegistryRow(
  agent: ACPAgentDescriptor,
  alias: string | undefined,
  local: DetectedAgent | undefined,
  idWidth: number,
): string {
  const kind = distKind(agent.acp.command);
  const aliasBit = alias ? `  (also ${alias})` : '';
  if (kind === 'local') {
    if (local?.installed) {
      const ver = local.version?.split('\n')[0]?.trim();
      const note = ver ? `  ${ver}` : '  on PATH';
      return `  ✓ ${agent.id.padEnd(idWidth)}  ${agent.displayName}${aliasBit}${note}`;
    }
    const reason = local?.reason ?? 'not on PATH';
    return `  ✗ ${agent.id.padEnd(idWidth)}  ${agent.displayName}${aliasBit}  (${reason})`;
  }
  const pkg = (agent.acp.args ?? []).find((a) => a !== '-y' && !a.startsWith('--'));
  const note = pkg ? `${kind} ${pkg}` : kind;
  return `  ▸ ${agent.id.padEnd(idWidth)}  ${agent.displayName}${aliasBit}  ${note}`;
}

export function formatAcpAgentList(opts: {
  live: LoadedAcpRegistry | null;
  detected: readonly DetectedAgent[];
}): string {
  const { live, detected } = opts;
  const detectedById = new Map(detected.map((d) => [d.id, d]));

  if (live && live.agents.length > 0) {
    const aliasOf = reverseAliases();
    const when = live.fetchedAt ? live.fetchedAt.slice(0, 19).replace('T', ' ') : 'locally';
    const rows = [...live.agents].sort((a, b) => {
      const rank = (command: string) => {
        const k = distKind(command);
        return k === 'local' ? 0 : k === 'uvx' ? 1 : 2;
      };
      const r = rank(a.acp.command) - rank(b.acp.command);
      return r !== 0 ? r : a.id.localeCompare(b.id);
    });
    const idWidth = Math.max(16, ...rows.map((a) => a.id.length));
    const lines: string[] = [
      `Official ACP registry — ${live.agents.length} agents (synced ${when}).`,
      'Spawn ids below are what `/acp <id> <task>` and `/acp <id> --bg` accept.',
      '',
    ];
    for (const agent of rows) {
      const alias = aliasOf[agent.id];
      lines.push(
        formatRegistryRow(agent, alias, localProbe(agent.id, alias, detectedById), idWidth),
      );
    }

    const leftover = detected.filter((d) => {
      if (live.byId[d.id]) return false;
      const mapped = REGISTRY_ID_ALIASES[d.id];
      return !(mapped && live.byId[mapped]);
    });
    if (leftover.length > 0) {
      lines.push('');
      lines.push('Bundled extras (not in the official registry — experimental):');
      for (const d of leftover) {
        const mark = d.installed ? '✓' : '✗';
        const extra = d.installed
          ? (d.version?.split('\n')[0] ?? '')
          : (d.reason ?? 'not installed');
        lines.push(`  ${mark} ${d.id.padEnd(16)}  ${d.displayName}  (${extra})`);
      }
    }
    lines.push('');
    lines.push(
      'Spawn: /acp <id> <task>   Background: /acp <id> --bg <task>   Probe: /acp probe <id>',
    );
    return lines.join('\n');
  }

  const installed = detected.filter((a) => a.installed);
  const missing = detected.filter((a) => !a.installed);
  const lines: string[] = [
    'Bundled offline catalog (not the official registry).',
    'Run `/acp sync` to replace this list with agentclientprotocol/registry.',
    '',
  ];
  for (const a of installed) {
    const ver = a.version ? `  (${a.version.split('\n')[0]})` : '';
    lines.push(`  ✓ ${a.id.padEnd(16)} ${a.displayName}${ver}`);
  }
  for (const a of missing) {
    lines.push(`  ✗ ${a.id.padEnd(16)} ${a.displayName}  (${a.reason ?? 'not installed'})`);
  }
  lines.push('');
  lines.push(`${installed.length} of ${detected.length} bundled agents installed locally.`);
  return lines.join('\n');
}

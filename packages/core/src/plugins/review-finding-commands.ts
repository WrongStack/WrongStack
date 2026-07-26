/**
 * Finding-store slash commands.
 *
 * FS-P0.5: Provides `/review findings` and `/review finding <id>` commands
 * for viewing persisted Chimera review findings.
 *
 * @module review-finding-commands
 */

import { FINDING_DEFAULT_PAGE_SIZE } from './review-finding-store.js';

/**
 * Run the review findings command.
 *
 * Usage:
 *   /review findings [--severity <s>] [--status <s>] [--limit <n>]
 *   /review finding <id>
 *   /review findings --help
 *
 * Reads the project's finding store from the project root.
 */
export interface FindingCommandContext {
  /** Project root directory (~/.wrongstack/projects/<slug>) */
  projectDir: string;
}

/**
 * Execute a finding-store command.
 */
export async function executeFindingCommand(
  args: string[],
  ctx: FindingCommandContext,
): Promise<string> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return helpText();
  }

  const subcommand = args[0]!;

  if (subcommand === 'findings' || subcommand === 'list') {
    return listFindings(args.slice(1), ctx);
  }

  if (subcommand === 'finding') {
    const id = args[1];
    if (!id) return 'Usage: /review finding <id>';
    return showFinding(id, ctx);
  }

  if (subcommand === 'status') {
    return showStatus(ctx);
  }

  return `Unknown subcommand: ${subcommand}. Use /review findings --help for usage.`;
}

function helpText(): string {
  return [
    '## /review findings — Chimera Finding Store',
    '',
    '| Command | Description |',
    '|---|---|',
    '| `/review findings` | List all active findings grouped by severity |',
    '| `/review findings --status <s>` | Filter by status (active, triaged, in_progress, resolved, ignored) |',
    '| `/review findings --severity <s>` | Filter by severity (critical, high, medium, low) |',
    '| `/review findings --limit <n>` | Max results (default 20) |',
    '| `/review finding <id>` | Show a single finding with full lifecycle |',
    '| `/review status` | Show store statistics |',
    '',
    'The finding store is at `~/.wrongstack/projects/<slug>/review-findings.jsonl`.',
    'Findings are created automatically when a Chimera review completes.',
  ].join('\n');
}

async function loadStore(ctx: FindingCommandContext) {
  const { JsonlFindingStore } = await import('./review-finding-store.js');
  const store = new JsonlFindingStore(ctx.projectDir);
  return store;
}

async function listFindings(
  args: string[],
  ctx: FindingCommandContext,
): Promise<string> {
  let severityFilter: string | undefined;
  let statusFilter: string | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--severity' && i + 1 < args.length) {
      severityFilter = args[++i]!;
    } else if (args[i] === '--status' && i + 1 < args.length) {
      statusFilter = args[++i]!;
    } else if (args[i] === '--limit' && i + 1 < args.length) {
      limit = Number.parseInt(args[++i]!, 10) || 20;
    }
  }

  const store = await loadStore(ctx);
  const all = await store.list({
    ...(severityFilter ? { severities: [severityFilter as any] } : {}),
    ...(statusFilter ? { statuses: [statusFilter as any] } : {}),
    limit,
  });

  if (all.length === 0) {
    const filters = [severityFilter && `severity=${severityFilter}`, statusFilter && `status=${statusFilter}`]
      .filter(Boolean).join(', ');
    return `No findings found${filters ? ` (${filters})` : ''}.`;
  }

  const lines: string[] = ['| Severity | Status | File | Title |',
    '|---|---|---|---|'];
  for (const f of all) {
    const location = f.location?.file ?? 'unknown';
    const file = location.substring(location.lastIndexOf('/') + 1).substring(location.lastIndexOf('\\') + 1) || location;
    const severityEmoji = f.severity === 'critical' ? '🔴' : f.severity === 'high' ? '🟠' : f.severity === 'medium' ? '🟡' : '⚪';
    const title = f.title.length > 60 ? f.title.substring(0, 57) + '...' : f.title;
    lines.push(`| ${severityEmoji} ${f.severity} | ${f.status} | \`${file}\` | ${title} |`);
  }

  lines.push('', `_${all.length} finding(s) shown. Use \`/review finding <id>\` for details._`);
  return lines.join('\n');
}

async function showFinding(id: string, ctx: FindingCommandContext): Promise<string> {
  const store = await loadStore(ctx);
  const finding = await store.get(id);
  if (!finding) return `Finding not found: ${id}`;

  const lines: string[] = [
    `## ${finding.severity.toUpperCase()}: ${finding.title}`,
    '',
    `**ID:** \`${finding.id}\``,
    `**File:** \`${finding.location?.file ?? 'unknown'}\`${finding.location?.line ? `:${finding.location.line}` : ''}`,
    `**Severity:** ${finding.severity}`,
    `**Status:** ${finding.status}`,
    `**Source:** ${finding.source}`,
    `**Created:** ${finding.createdAt}`,
    '',
    finding.description,
  ];

  if (finding.suggestedFix) {
    lines.push('', '**Suggested fix:**', finding.suggestedFix);
  }

  const events = await store.getEvents(id);
  if (events.length > 0) {
    lines.push('', '**Lifecycle:**', '');
    for (const ev of events) {
      const eventLine = `- \`${ev.timestamp}\` ${ev.fromStatus ?? 'none'} → ${ev.toStatus} (${ev.eventType}) by ${ev.actorId}`;
      lines.push(eventLine);
      if (ev.reason) lines.push(`  _${ev.reason}_`);
    }
  }

  lines.push('', `_Fingerprint: \`${finding.fingerprint.substring(0, 16)}…\`_`);
  return lines.join('\n');
}

async function showStatus(ctx: FindingCommandContext): Promise<string> {
  const store = await loadStore(ctx);
  const all = await store.list({ limit: 9999 });

  const counts: Record<string, number> = {};
  const severityCounts: Record<string, number> = {};
  for (const f of all) {
    counts[f.status] = (counts[f.status] || 0) + 1;
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
  }

  return [
    '## Finding Store Status',
    '',
    `**Total findings:** ${all.length}`,
    '',
    '**By status:**',
    ...Object.entries(counts).map(([k, v]) => `  - ${k}: ${v}`),
    '',
    '**By severity:**',
    ...Object.entries(severityCounts).map(([k, v]) => `  - ${k}: ${v}`),
    '',
    `_Page size: ${FINDING_DEFAULT_PAGE_SIZE}_`,
  ].join('\n');
}

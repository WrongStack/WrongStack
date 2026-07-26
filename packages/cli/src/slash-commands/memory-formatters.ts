import type {
  FindMemoriesForFileResponse,
  LegacyImportResult,
  MemoryCandidate,
  MemoryForFileMatch,
  MemoryGraphEdge,
  MemoryVerificationResult,
  Sage,
  SageAuditRecord,
  SageHygieneReport,
  SageKind,
  SageStats,
} from '@wrongstack/sage';

function previewText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

export function formatForFileResponse(
  filePath: string,
  response: FindMemoriesForFileResponse,
): string {
  const lines: string[] = [
    `## SAGE — File: \`${filePath}\``,
    '',
    `Total ${response.totalCount} match${response.totalCount === 1 ? '' : 'es'} ` +
      `(${response.activeCount} active, ${response.supersededCount} superseded, ` +
      `${response.reviewPendingCount} pending review).`,
  ];
  const renderBucket = (label: string, matches: ReadonlyArray<MemoryForFileMatch>): void => {
    if (matches.length === 0) return;
    lines.push('', `### ${label} (${matches.length})`);
    for (const match of matches) {
      const flags: string[] = [];
      if (match.pendingReview) {
        flags.push(`review:${match.pendingReview.reason}`);
      }
      if (match.supersededByActiveId) flags.push('superseded');
      const flagSuffix = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
      const strengthPct = Math.round(match.matchStrength * 100);
      lines.push(
        `- **${match.memory.kind}** (${strengthPct}% via ${match.matchedVia})${flagSuffix}: ` +
          `${previewText(match.memory.text, 140)}`,
      );
      lines.push(`    \`${match.memory.id}\``);
    }
  };
  renderBucket('Cursor boost (symbol)', response.symbolMatches);
  renderBucket('File-scoped', response.primaryMatches);
  renderBucket('Mentioned in', response.relatedMatches);
  if (response.totalCount === 0) {
    lines.push('', '_No memories attached to this file yet._');
  }
  return lines.join('\n');
}

export function requiresSage(command: string): { message: string } {
  return {
    message: `\`/memory ${command}\` requires the SAGE backend. Enable \`Sage.enabled\` and restart the session.`,
  };
}

export function formatSageMemories(memories: Sage[], title: string): string {
  if (memories.length === 0) return `No SAGE entries matched ${title}.`;
  return [
    `## SAGE — ${title}`,
    ...memories.map(
      (memory) => `- \`${memory.id}\` [${memory.kind}|${memory.status}] ${memory.text}`,
    ),
  ].join('\n');
}

export function formatLegacyEntries(entries: string[], query: string): string {
  return entries.length === 0
    ? `No memory entries matched "${query}".`
    : [`## Memory — Search: ${query}`, ...entries.map((text) => `- ${text}`)].join('\n');
}

export function formatGraph(edges: MemoryGraphEdge[], query: string): string {
  if (edges.length === 0) return `No graph relationships matched "${query}".`;
  return [
    `## Memory Graph — ${query}`,
    ...edges.map(
      (edge) =>
        `- ${edge.from} —[${edge.relation}:${edge.weight.toFixed(2)}]→ ${edge.to}` +
        (edge.evidence?.length ? ` _(why: ${edge.evidence.join(', ')})_` : ''),
    ),
  ].join('\n');
}

export function formatVerification(results: MemoryVerificationResult[]): string {
  if (results.length === 0) return 'No memories were available to verify.';
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  const lines = [
    '## SAGE Verification',
    ...[...counts].map(([status, count]) => `- ${status}: ${count}`),
  ];
  for (const result of results.filter((item) => item.status !== 'verified').slice(0, 20)) {
    lines.push(
      `- \`${result.memoryId}\`: ${result.anchors.map((anchor) => anchor.reason).join('; ') || result.status}`,
    );
  }
  return lines.join('\n');
}

export function formatHygiene(report: SageHygieneReport): string {
  const unusedNote =
    report.archivedUnused > 0
      ? ` (${report.archivedUnused} for repeated injection without use)`
      : '';
  return [
    '## SAGE Hygiene',
    `Examined ${report.examined}; deduplicated ${report.deduplicated}; superseded ${report.superseded}.`,
    `Verified ${report.verified}; staled ${report.staled}; archived ${report.archived}${unusedNote}; deleted ${report.deleted}.`,
  ].join('\n');
}

export function formatCandidates(candidates: MemoryCandidate[]): string {
  if (candidates.length === 0) return 'No memory candidates.';
  return [
    '## Memory Candidates',
    ...candidates.map(
      (candidate) =>
        `- \`${candidate.id}\` [${candidate.status}|${candidate.kind}] ${candidate.text}`,
    ),
  ].join('\n');
}

export function formatAudit(rows: SageAuditRecord[]): string {
  if (rows.length === 0) return 'SAGE audit log is empty.';
  return [
    '## SAGE Audit',
    ...rows.map(
      (row) =>
        `- ${row.at} ${row.event}${row.memoryId ? ` \`${row.memoryId}\`` : ''}${row.reason ? ` — ${row.reason}` : ''}`,
    ),
  ].join('\n');
}

export function formatLegacyImport(result: LegacyImportResult): string {
  return `Legacy import complete: ${result.imported} imported, ${result.skipped} skipped from ${result.files} file(s).`;
}

export function formatSageStats(
  stats: SageStats,
  scopedCount?: number,
  scopedRoles?: string,
): string {
  const lines = [
    '## SAGE Stats',
    `Total: ${stats.total}; active ${stats.byStatus.active}; stale ${stats.byStatus.stale}; archived ${stats.byStatus.archived}; deleted ${stats.byStatus.deleted}.`,
    `Graph edges: ${stats.edges}.`,
    `Kinds: ${
      Object.entries(stats.byKind)
        .map(([kind, count]) => `${kind}=${count}`)
        .join(', ') || 'none'
    }.`,
  ];
  if (scopedCount !== undefined) {
    lines.push(`Audience-scoped: ${scopedCount}${scopedRoles ? ` (${scopedRoles})` : ''}.`);
  }
  return lines.join('\n');
}

export function formatSageShow(stats: SageStats, memories: Sage[]): string {
  const lines: string[] = [];
  const active = stats.byStatus['active'] ?? 0;
  const stale = stats.byStatus['stale'] ?? 0;
  const archived = stats.byStatus['archived'] ?? 0;
  lines.push('## 🧠 SAGE');
  lines.push('');
  lines.push(
    `**Total:** ${stats.total} · 🟢 ${active} active · 🟡 ${stale} stale · 🔵 ${archived} archived`,
  );
  lines.push(`**Graph edges:** ${stats.edges}`);
  lines.push('');

  const kindOrder: SageKind[] = [
    'fact',
    'decision',
    'convention',
    'preference',
    'anti_pattern',
    'warning',
    'workflow',
    'bug_root_cause',
    'file_note',
    'symbol_note',
    'command_note',
    'summary',
  ];
  const kindRows: string[] = [];
  for (const kind of kindOrder) {
    const count = stats.byKind[kind] ?? 0;
    if (count === 0) continue;
    kindRows.push(`- **${kind}**: ${count}`);
  }
  if (kindRows.length > 0) {
    lines.push('### 📊 By kind');
    lines.push('');
    lines.push(...kindRows);
    lines.push('');
  }

  lines.push('### 📋 Entries');
  lines.push('');
  for (const mem of memories) {
    const tags =
      mem.tags.length > 0
        ? ` \`${mem.tags.slice(0, 3).join('` `')}${mem.tags.length > 3 ? '…' : ''}\``
        : '';
    const preview = mem.text.replace(/\s+/g, ' ').trim().slice(0, 120);
    const statusIcon =
      mem.status === 'active'
        ? '🟢'
        : mem.status === 'stale'
          ? '🟡'
          : mem.status === 'archived'
            ? '🔵'
            : '⚪';
    lines.push(`- ${statusIcon} \`${mem.id.slice(0, 12)}…\` [${mem.kind}] ${preview}${tags}`);
  }
  lines.push('');
  lines.push(`*${memories.length} entr${memories.length === 1 ? 'y' : 'ies'}*`);

  return lines.join('\n');
}

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
import type { SearchRaceResult } from '@wrongstack/vector-memory';

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

/** Pre-collected diagnostic data for `formatMemoryDiagnostics`. */
export interface MemoryDiagnostics {
  sageStats: SageStats;
  /** Total SAGE entries (active + non-active) in the corpus. */
  sageTotal: number;
  vector:
    | {
        entries: number;
        vectors: number;
        providers: string[];
        modelId: string;
        dimensions: number;
        cacheEntries: number;
        cacheProviders: number;
        totalUseCount: number;
        oldestLastUsedAt: string | null;
        storePath: string;
        /** Vector entries whose `metadata.sageId` resolves in SAGE. */
        mirroredInSage: number;
        /** Vector entries without a `metadata.sageId` (standalone). */
        standalone: number;
      }
    | undefined;
}

/**
 * Two-system health snapshot — covers SAGE stats, vector memory
 * stats, and the cross-system coverage (how many SAGE memories have a
 * vector mirror). Surfaces the value of running both stores side by
 * side: the operator sees drift (vector entries without a SAGE id),
 * the embedding cache hit ratio, and the active provider / dimension.
 */
export function formatMemoryDiagnostics(diag: MemoryDiagnostics): string {
  const lines: string[] = ['🩺 Memory diagnostics', ''];

  // SAGE side
  const byStatus = Object.entries(diag.sageStats.byStatus)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const byKind = Object.entries(diag.sageStats.byKind)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  lines.push('SAGE (lexical):');
  lines.push(`  total entries:  ${diag.sageTotal}`);
  lines.push(`  by status:      ${byStatus || '∅'}`);
  lines.push(`  by kind:        ${byKind || '∅'}`);
  if (diag.sageStats.injections !== undefined) {
    lines.push(`  injections:     ${diag.sageStats.injections}`);
  }
  if (diag.sageStats.uses !== undefined) {
    lines.push(`  uses:           ${diag.sageStats.uses}`);
  }
  lines.push('');

  // Vector side
  if (!diag.vector) {
    lines.push('Vector memory: disabled — running on the SAGE-only surface.');
  } else {
    const v = diag.vector;
    lines.push('Vector (semantic):');
    lines.push(`  entries:        ${v.entries}`);
    lines.push(`  with vectors:   ${v.vectors}`);
    lines.push(`  providers:      ${v.providers.join(', ') || '∅'}`);
    lines.push(`  model:          ${v.modelId} (${v.dimensions}-dim)`);
    lines.push(
      `  cache:          ${v.cacheEntries} rows · ${v.cacheProviders} provider(s) · ${v.totalUseCount} hits`,
    );
    if (v.oldestLastUsedAt) {
      lines.push(`  cache oldest:   ${v.oldestLastUsedAt}`);
    }
    lines.push(`  store path:     ${v.storePath}`);
    lines.push('');
    lines.push('Cross-system coverage:');
    lines.push(`  vector ↔ SAGE:  ${v.mirroredInSage} mirrored`);
    if (v.standalone > 0) {
      lines.push(
        `  standalone:     ${v.standalone} vector-only entries (no SAGE id — lexical recall misses these)`,
      );
    }
    if (v.mirroredInSage === 0 && diag.sageTotal > 0) {
      lines.push('  💡 Run `wrongstack --vector-sync` to backfill the vector mirror.');
    }
  }
  return lines.join('\n');
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

/**
 * Human-readable rendering of a `SearchRaceResult` — the channel
 * comparison that makes the dual system's value visible. The output
 * groups memories into three buckets: **both** (lexical + vector
 * agreement), **lexical only** (rare-token matches the embedding
 * model would under-rank), and **vector only** (semantic recall the
 * FTS index would have missed). The summary metrics above the lists
 * make the "what would I have missed?" question answerable in one
 * glance.
 */
export function formatSearchRace(race: SearchRaceResult): string {
  const lines: string[] = [];
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  lines.push(`## 🏁 Search race — "${race.query}"`);
  lines.push('');
  lines.push(
    `lexical: ${race.metrics.lexicalCount} · vector: ${race.metrics.vectorCount} · ` +
      `overlap: ${race.metrics.overlapCount} · agreement: ${pct(race.metrics.agreementRatio)}`,
  );
  if (race.metrics.lexicalOnlyRatio > 0) {
    lines.push(
      `  ↳ lexical-only: ${pct(race.metrics.lexicalOnlyRatio)} of lexical recall is invisible to vector.`,
    );
  }
  if (race.metrics.vectorOnlyRatio > 0) {
    lines.push(
      `  ↳ vector-only: ${pct(race.metrics.vectorOnlyRatio)} of vector recall is invisible to lexical.`,
    );
  }
  lines.push('');
  if (race.overlap.length > 0) {
    lines.push('### ✅ Both channels');
    for (const row of race.overlap) {
      lines.push(
        `- \`${row.id.slice(0, 12)}…\` L=${pct(row.lexicalScore)} V=${pct(row.vectorScore)}  ${row.preview}`,
      );
    }
    lines.push('');
  }
  if (race.lexicalOnly.length > 0) {
    lines.push('### 🅰️ Lexical only (vector missed)');
    for (const row of race.lexicalOnly) {
      lines.push(`- \`${row.id.slice(0, 12)}…\` L=${pct(row.lexicalScore ?? 0)}  ${row.preview}`);
    }
    lines.push('');
  }
  if (race.vectorOnly.length > 0) {
    lines.push('### 🅱️ Vector only (lexical missed)');
    for (const row of race.vectorOnly) {
      lines.push(`- \`${row.id.slice(0, 12)}…\` V=${pct(row.vectorScore ?? 0)}  ${row.preview}`);
    }
    lines.push('');
  }
  if (race.overlap.length === 0 && race.lexicalOnly.length === 0 && race.vectorOnly.length === 0) {
    lines.push('_No memories matched either channel for this query._');
  }
  return lines.join('\n');
}

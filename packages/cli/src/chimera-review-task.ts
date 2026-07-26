import type {
  CascadeAgentKind,
  ChimeraCascadeNeededPayload,
  ChimeraReviewNeededPayload,
} from '@wrongstack/core/plugin';

// Plain .slice() operates on UTF-16 code units and can split a surrogate pair.
export function truncateAtCodePointBoundary(text: string, maxCodeUnits: number): string {
  if (text.length <= maxCodeUnits) return text;
  let result = '';
  for (const ch of text) {
    if (result.length + ch.length > maxCodeUnits) break;
    result += ch;
  }
  return result;
}

export function buildChimeraReviewTaskDescription(p: ChimeraReviewNeededPayload): string {
  const lines: string[] = [];
  lines.push(`Review the following ${p.files.length} file(s) changed in this session at ${p.cwd}.`);
  lines.push('');
  for (const f of p.files) {
    lines.push(`## [${f.status.toUpperCase()}] ${f.path}`);
    if (f.diff) {
      lines.push('');
      lines.push('```diff');
      lines.push(f.diff);
      lines.push('```');
    } else if (f.status === 'added') {
      lines.push('');
      lines.push('(New file — full content provided)');
    }
    lines.push('');
  }

  if (p.allChangedFiles && p.allChangedFiles.length > p.files.length) {
    const reviewedPaths = new Set(p.files.map((f) => f.path));
    const siblings = p.allChangedFiles
      .filter((s) => !reviewedPaths.has(s.path))
      .map((s) => `  ${s.path} (${s.status})`);
    if (siblings.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push(
        `**Also changed this session (${siblings.length} files — for context, NOT in your review scope):**`,
      );
      lines.push(siblings.slice(0, 30).join('\n'));
      lines.push('');
    }
  }

  if (p.recentCommits && p.recentCommits.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('**Recent commits (newest first):**');
    for (const c of p.recentCommits) lines.push(`  ${c}`);
    lines.push('');
  }

  if (p.activeTodos && p.activeTodos.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`**Active task items (${p.activeTodos.length}):**`);
    for (const t of p.activeTodos) {
      lines.push(`  [${t.status}] ${t.content}`);
    }
    lines.push('');
  }

  if (p.kanbanCard) {
    lines.push('---');
    lines.push('');
    lines.push(`**Kanban card: ${p.kanbanCard.title}**`);
    if (p.kanbanCard.description) {
      lines.push(`  ${p.kanbanCard.description.slice(0, 500)}`);
    }
    if (p.kanbanCard.successCriteria && p.kanbanCard.successCriteria.length > 0) {
      lines.push('  **Success criteria:**');
      for (const sc of p.kanbanCard.successCriteria) lines.push(`    - ${sc}`);
    }
    lines.push('');
  }

  if (p.fileProvenance && p.fileProvenance.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('**File provenance (Chronicle):**');
    for (const fp of p.fileProvenance) {
      const parts: string[] = [];
      if (fp.agentId) parts.push(`agent: ${fp.agentId}`);
      if (fp.taskId) parts.push(`task: ${fp.taskId}`);
      if (fp.eventType) parts.push(fp.eventType);
      if (fp.observedAt) parts.push(fp.observedAt);
      lines.push(`  ${fp.path} — ${parts.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Read each file using the read tool. For modified files, focus on the');
  lines.push('diff above — do not re-review unchanged pre-existing code.');
  lines.push('Check for bugs, type issues, security problems, and produce a');
  lines.push('structured review report.');

  return lines.join('\n');
}

export function buildChimeraCascadeTaskDescription(
  agentKind: CascadeAgentKind,
  p: ChimeraCascadeNeededPayload,
): string {
  const fileList = p.bundle.files.map((f) => `- ${f.path}`).join('\n');
  const reportSlice = truncateAtCodePointBoundary(p.reviewText, 12_000);
  const severityLine = `Critical: ${p.severities.critical}, High: ${p.severities.high}, Medium: ${p.severities.medium}`;

  if (agentKind === 'security-scanner') {
    return [
      `You are a security cascade agent. A Chimera code review flagged security-relevant findings.`,
      ``,
      `Repository: ${p.bundle.cwd}`,
      `Severity summary: ${severityLine}`,
      ``,
      `--- Review report ---`,
      reportSlice,
      ``,
      `--- Changed files ---`,
      fileList,
      ``,
      `Investigate the security findings above. Read the flagged files, confirm or refute`,
      `each finding, and **apply fixes** for confirmed vulnerabilities using the edit tool.`,
      `Use severity (Critical/High/Medium), file:line citations, and remediation steps.`,
      `After fixing, run the project's typecheck and linter to verify. If a finding is a`,
      `false positive, say so and do not modify the file.`,
    ].join('\n');
  }
  return [
    `You are a bug-hunter cascade agent. A Chimera code review flagged correctness defects.`,
    ``,
    `Repository: ${p.bundle.cwd}`,
    `Severity summary: ${severityLine}`,
    ``,
    `--- Review report ---`,
    reportSlice,
    ``,
    `--- Changed files ---`,
    fileList,
    ``,
    `Hunt for the bugs flagged above. Read the affected files, trace each finding to its`,
    `root cause, and **apply minimal fixes** for confirmed bugs using the edit tool.`,
    `Use severity (Critical/High/Medium), file:line citations. After fixing, run the`,
    `project's typecheck and linter to verify. If a finding is a false positive, say so`,
    `and do not modify the file.`,
  ].join('\n');
}

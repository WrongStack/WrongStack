import type {
  CascadeAgentKind,
  ChimeraCascadeNeededPayload,
  ChimeraReviewNeededPayload,
} from '@wrongstack/core/plugin';
import { parseReviewSeverity } from '@wrongstack/core/plugin';

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

export function isChimeraAllClearReview(text: string): boolean {
  const severities = parseReviewSeverity(text);
  if (severities.critical > 0 || severities.high > 0 || severities.medium > 0) {
    return false;
  }

  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith('## 🦂 chimera review — all clear') ||
    normalized.includes('chimera review: all clear')
  );
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
      if (f.content && f.content.length <= 25_000) {
        lines.push('(New file content:)');
        lines.push('```');
        lines.push(f.content);
        lines.push('```');
      } else {
        lines.push('(New file — large content, use read tool only if needed)');
      }
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
  lines.push('**Review Instructions:**');
  lines.push(
    '- Review the diffs and new file contents carefully for real bugs, broken logic, null dereferences, and security gaps.',
  );
  lines.push(
    '- Stay strictly within the scoped diffs. DO NOT audit unchanged files, pre-existing debt, or stylistic preferences.',
  );
  lines.push('- Use tools only when you need surrounding lines to verify a concrete issue.');
  lines.push('- Once the diff is validated, output your report (findings or all-clear) promptly.');

  return lines.join('\n');
}

/**
 * The machine-evidence contract every cascade fix agent must satisfy before
 * its work counts as verified. The agent runs the real verification commands
 * and returns a JSON block with the exact commands and their exit codes; the
 * re-review step re-runs those commands and compares.
 */
const CASCADE_EVIDENCE_INSTRUCTIONS = [
  `After fixing, run the project's REAL verification commands on the code you changed`,
  `(typecheck, lint, and the tests covering the fixed code) and return a machine-evidence`,
  `block as the LAST section of your response. The block MUST be a fenced JSON block`,
  `(exactly \`\`\`json ... \`\`\`) with this shape:`,
  ``,
  '```json',
  '{',
  '  "verification_evidence": {',
  '    "typecheck": { "command": "pnpm typecheck", "exitCode": 0 },',
  '    "lint":      { "command": "pnpm lint", "exitCode": 0 },',
  '    "tests":     { "command": "pnpm test --filter affected", "exitCode": 0 }',
  '  }',
  '}',
  '```',
  ``,
  `Rules:`,
  `- \`command\` must be the EXACT command you ran (plain executable + args, no shell`,
  `  chaining like \`&&\`/\`;\`/\`|\`, no redirection, no shell expansion). These commands are`,
  `  re-run verbatim by the orchestrator to verify your work.`,
  `- \`exitCode\` is the real process exit code you observed: 0 = passed, non-zero = failed.`,
  `  Never invent or omit an exit code. If a command cannot be run, omit that key entirely`,
  `  and explain why in your report text — an omitted key is honest, a fabricated 0 is not.`,
  `- If your fix does not pass a command, report the true non-zero exit code; the`,
  `  orchestrator will treat the fix as unverified and keep the finding open.`,
  `- At least \`typecheck\` must be present; include \`lint\` and \`tests\` when the project`,
  `  has them.`,
].join('\n');

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
      `If a finding is a false positive, say so and do not modify the file.`,
      ``,
      CASCADE_EVIDENCE_INSTRUCTIONS,
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
    `Use severity (Critical/High/Medium), file:line citations. If a finding is a false`,
    `positive, say so and do not modify the file.`,
    ``,
    CASCADE_EVIDENCE_INSTRUCTIONS,
  ].join('\n');
}

import type { MemoryEvidenceSnapshot } from '@wrongstack/sage';

export { type MemoryEvidenceSnapshot, snapshotMemoryEvidence } from '@wrongstack/sage';

export interface MemoryCompanionVerdict {
  verdict: 'supported' | 'outdated' | 'contradicted' | 'unverifiable' | 'irrelevant';
  summary: string;
  evidence: Array<{ path: string; quote: string }>;
}

function normalizeEvidencePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

function quoteMatchesText(fileText: string, quote: string): boolean {
  if (fileText.includes(quote)) return true;
  if (fileText.includes('\r\n') || quote.includes('\r\n')) {
    return fileText.replaceAll('\r\n', '\n').includes(quote.replaceAll('\r\n', '\n'));
  }
  return false;
}

function extractJsonVerdict(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to fenced or balanced object extraction.
  }
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const body = match[1]?.trim();
    if (!body) continue;
    try {
      return JSON.parse(body);
    } catch {
      // Try next block.
    }
  }
  const endIndices: number[] = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] === '}') endIndices.push(i);
  }
  for (const end of endIndices) {
    let depth = 0;
    let inString = false;
    for (let i = end; i >= 0; i--) {
      const ch = raw[i];
      if (ch === '"') {
        let backslashes = 0;
        while (i - 1 - backslashes >= 0 && raw[i - 1 - backslashes] === '\\') backslashes++;
        if (backslashes % 2 === 0) inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '}') depth++;
      else if (ch === '{') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(i, end + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

export function parseMemoryCompanionVerdict(
  raw: string,
  snapshot: MemoryEvidenceSnapshot,
): MemoryCompanionVerdict | undefined {
  try {
    if (!raw || raw.length > 8000) return;
    const parsed = extractJsonVerdict(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const value = parsed as Partial<MemoryCompanionVerdict>;
    if (
      !value.verdict ||
      !['supported', 'outdated', 'contradicted', 'unverifiable', 'irrelevant'].includes(
        value.verdict,
      ) ||
      typeof value.summary !== 'string' ||
      !value.summary.trim() ||
      value.summary.length > 800
    )
      return;
    const evidenceInput =
      value.evidence === undefined &&
      (value.verdict === 'unverifiable' || value.verdict === 'irrelevant')
        ? []
        : value.evidence;
    if (!Array.isArray(evidenceInput) || evidenceInput.length > 4) return;
    const normalizedEvidence: Array<{ path: string; quote: string }> = [];
    for (const e of evidenceInput) {
      if (
        !e ||
        typeof e.path !== 'string' ||
        typeof e.quote !== 'string' ||
        e.quote.trim().length < 12 ||
        e.quote.length > 400
      )
        return;
      const targetPath = normalizeEvidencePath(e.path);
      const matched = snapshot.files.find(
        (f) =>
          (f.path === e.path || normalizeEvidencePath(f.path) === targetPath) &&
          quoteMatchesText(f.text, e.quote),
      );
      if (!matched) return;
      normalizedEvidence.push({ path: matched.path, quote: e.quote });
    }
    if (
      ['supported', 'outdated', 'contradicted'].includes(value.verdict) &&
      normalizedEvidence.length === 0
    )
      return;
    return {
      verdict: value.verdict,
      summary: value.summary,
      evidence: normalizedEvidence,
    };
  } catch {
    return;
  }
}

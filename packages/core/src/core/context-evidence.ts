export interface ProviderMemoryEvidence {
  /** Stable owner key, for example `sage.tool-memory`. */
  source: string;
  /** Provider-bound evidence text; never appended to chat/tool history. */
  text: string;
}

export function setMemoryEvidenceList(
  currentList: ProviderMemoryEvidence[],
  source: string,
  text: string | undefined,
  maxChars = 6_000,
): ProviderMemoryEvidence[] {
  const key = source.trim();
  if (!key) return currentList;
  const clean = text?.trim();
  const retained = currentList.filter((entry) => entry.source !== key);
  if (clean) {
    const boundedMax = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
    if (boundedMax > 0) retained.push({ source: key, text: clean.slice(0, boundedMax) });
  }
  return retained.slice(-8);
}

export function clearMemoryEvidenceList(
  currentList: ProviderMemoryEvidence[],
  source?: string,
): ProviderMemoryEvidence[] {
  if (source === undefined) {
    return [];
  }
  return currentList.filter((entry) => entry.source !== source);
}

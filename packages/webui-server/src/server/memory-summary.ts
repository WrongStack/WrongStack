/** End a preview cut on a code-point boundary (never emit half a surrogate pair). */
function previewText(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Small graph/list cards. Full SAGE records remain behind the explicit get action. */
export function sageMemorySummary(value: unknown): Record<string, unknown> {
  const memory = value as Record<string, unknown>;
  return {
    id: memory['id'],
    kind: memory['kind'],
    status: memory['status'],
    scope: memory['scope'],
    revision: memory['revision'],
    importance: memory['importance'],
    preview: previewText(String(memory['text'] ?? '').replace(/\s+/g, ' '), 120),
    tags: Array.isArray(memory['tags']) ? memory['tags'].slice(0, 8) : [],
    anchorCount: Array.isArray(memory['anchors']) ? memory['anchors'].length : 0,
    sourceCount: Array.isArray(memory['sources']) ? memory['sources'].length : 0,
  };
}

const DISPLAY_KEYS = ['id', 'name', 'type'] as const;

/**
 * Convert persisted or legacy Kanban metadata to a safe display identifier.
 * Provider instances occasionally leak into old assignment records; select a
 * public identifier instead of rendering or serializing the whole object.
 */
export function kanbanMetadataText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim();
    return text || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  for (const key of DISPLAY_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

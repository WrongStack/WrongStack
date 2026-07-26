export interface ParsedRef {
  provider?: string;
  model: string;
}

export function parseRefInternal(ref: string): ParsedRef {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf('/');
  if (slash !== -1) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1).trim();
    if (provider) return { provider, model };
    return { model };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return { provider: parts[0]!, model: parts.slice(1).join(' ') };
  }
  return { model: trimmed };
}

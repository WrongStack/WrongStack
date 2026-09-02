/**
 * Small, dependency-file-focused parsing primitives.
 *
 * These helpers intentionally cover only the TOML/XML/YAML subsets used by
 * package manifests; they are not general-purpose format parsers.
 */

export function stripInlineComment(line: string, marker = '#'): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const character = line.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? undefined : (quote ?? character);
      continue;
    }
    if (!quote && line.startsWith(marker, index)) return line.slice(0, index).trimEnd();
  }
  return line;
}

export interface TomlKeyValue {
  readonly key: string;
  readonly value: string;
}

export function parseTomlKeyValue(line: string): TomlKeyValue | undefined {
  const cleaned = stripInlineComment(line).trim();
  const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.+)$/.exec(cleaned);
  if (!match) return undefined;
  const key = match[1] ?? match[2] ?? match[3];
  const value = match[4];
  return key && value ? { key, value: value.trim() } : undefined;
}

export function parseXmlAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const regex = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
  for (const match of source.matchAll(regex)) {
    const key = match[1];
    const value = match[3];
    if (key !== undefined && value !== undefined) attributes.set(key, value);
  }
  return attributes;
}

export function xmlTagValue(source: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<${escaped}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${escaped}>`, 'i')
    .exec(source)?.[1]
    ?.trim();
}

/**
 * Small, dependency-file-focused parsing primitives.
 *
 * These helpers intentionally cover only the TOML/XML/YAML subsets used by
 * package manifests; they are not general-purpose format parsers.
 */

/**
 * Drop a leading UTF-8 byte-order mark. Editors on Windows save JSON
 * manifests with one; npm, Composer and vcpkg accept it, but `JSON.parse`
 * throws and the adapter inventoried nothing.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function stripInlineComment(line: string, marker = '#'): string {
  if (marker.length === 0) return line;
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

/**
 * Drop `// …` and `/* … *\/` comments from a C-family manifest (Gradle
 * Groovy/Kotlin, Package.swift). A commented-out declaration is not a
 * dependency, but the collectors matched the raw text. Quote-aware, so the `//`
 * in `uri("https://…")` survives; a newline ends any open single-line string so
 * one stray quote cannot swallow the file.
 */
export function stripSlashComments(content: string): string {
  let out = '';
  let quote: string | undefined;
  for (let index = 0; index < content.length; index++) {
    const character = content.charAt(index);
    if (quote) {
      out += character;
      if (character === '\\') {
        out += content.charAt(index + 1);
        index++;
      } else if (character === quote || character === '\n') {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      out += character;
      continue;
    }
    if (character === '/' && content.charAt(index + 1) === '/') {
      const end = content.indexOf('\n', index);
      if (end < 0) break;
      index = end - 1;
      continue;
    }
    if (character === '/' && content.charAt(index + 1) === '*') {
      const end = content.indexOf('*/', index + 2);
      if (end < 0) break;
      out += ' ';
      index = end + 1;
      continue;
    }
    out += character;
  }
  return out;
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
  const regex = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  for (const match of source.matchAll(regex)) {
    const key = match[1];
    const value = match[3];
    if (key !== undefined && value !== undefined) attributes.set(key, decodeXmlEntities(value));
  }
  return attributes;
}

/**
 * MSBuild and Maven ignore `<!-- … -->`; a commented-out item is not a
 * declaration, and matching the raw text inventoried removed packages as live
 * dependencies (and let a commented property override the live one).
 */
export function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

export function xmlTagValue(source: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = new RegExp(`<${escaped}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${escaped}>`, 'i')
    .exec(source)?.[1]
    ?.trim();
  return value === undefined ? undefined : decodeXmlEntities(value);
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal ?? '', decimal ? 10 : 16);
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return entity;
        }
      }
      const named: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
      };
      return named[entity.toLowerCase()] ?? entity;
    },
  );
}

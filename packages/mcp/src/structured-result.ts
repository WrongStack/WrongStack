import type { JSONSchema } from '@wrongstack/contracts/types';
import { validateAgainstSchema } from '@wrongstack/core/utils';

/**
 * Structured tool output (spec 2025-06-18): a tool may declare an
 * `outputSchema` and return the typed result in `structuredContent` next to
 * its ordinary content blocks.
 *
 * The spec asks servers to repeat the object as serialized JSON in a text
 * block, but many send only a short summary there — reading `content` alone
 * then loses the actual data. And the client SHOULD validate the object
 * against the declared schema.
 */

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Text blocks of a `tools/call` content array (or the content itself when it is a string). */
function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? [String((block as { text?: unknown }).text ?? '')]
      : [],
  );
}

/** Does some text block already carry `structured` as JSON? Then showing it twice is noise. */
function alreadyInText(content: unknown, structured: Record<string, unknown>): boolean {
  const wanted = canonical(structured);
  return textBlocks(content).some((text) => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return false;
    try {
      return canonical(JSON.parse(trimmed)) === wanted;
    } catch {
      return false;
    }
  });
}

/**
 * The model-facing text of a successful call: the rendered content, plus the
 * structured result when the content does not already contain it, plus a
 * notice when the result breaks the tool's own `outputSchema`.
 */
export function renderStructuredResult(
  rendered: string,
  content: unknown,
  structured: Record<string, unknown> | undefined,
  outputSchema: Record<string, unknown> | undefined,
): string {
  if (!structured) return rendered;
  const parts = [rendered];
  if (!alreadyInText(content, structured)) {
    parts.push(`Structured result:\n${JSON.stringify(structured, null, 2)}`);
  }
  if (outputSchema) {
    const check = validateAgainstSchema(structured, outputSchema as JSONSchema);
    if (!check.ok) {
      const problems = check.errors
        .slice(0, 3)
        .map((e) => `${e.path || '(root)'}: ${e.message}`)
        .join('; ');
      parts.push(
        `[The structured result does not match the tool's declared output schema — ${problems}]`,
      );
    }
  }
  return parts.filter((part) => part.length > 0).join('\n\n');
}

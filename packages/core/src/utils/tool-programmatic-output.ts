import type { ToolResultBlock } from '@wrongstack/contracts/types/blocks';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import type { JSONSchema } from '@wrongstack/contracts/types/tool';
import { validateAgainstSchema } from './json-schema-validate.js';

// Values live only as long as their execution result. They never enter provider
// blocks, session JSONL, event previews or replay sidecars by object spreading.
const values = new WeakMap<ToolResultBlock, { value: unknown; content: string }>();
const MAX_BYTES = 8 * 1024 * 1024;

export function prepareProgrammaticOutput(
  output: unknown,
  schema: JSONSchema,
  scrubber: SecretScrubber,
): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  function copy(value: unknown, depth: number, inObject = false): unknown {
    if (++nodes > 250_000)
      throw new Error('Structured tool output exceeds 250000 values; request a smaller result');
    if (depth > 64) throw new Error('Structured tool output exceeds 64 nesting levels');
    if (value === undefined && inObject) return undefined;
    if (typeof value === 'string') {
      stringBytes += Buffer.byteLength(value, 'utf8');
      if (stringBytes > MAX_BYTES)
        throw new Error('Structured tool output exceeds 8 MiB; request a smaller result');
      return scrubber.scrub(value);
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null)
      throw new Error('Structured tool output must be JSON');
    if (seen.has(value)) throw new Error('Structured tool output contains a cycle');
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
      throw new Error('Structured tool output must contain plain JSON objects');
    }
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const entries: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !('value' in descriptor))
          throw new Error('Structured tool output has a sparse array or accessor');
        entries.push(copy(descriptor.value, depth + 1));
      }
      result = entries;
    } else {
      const entries: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) throw new Error('Structured tool output has an accessor');
        const copied = copy(descriptor.value, depth + 1, true);
        if (copied !== undefined) {
          const scrubbedKey = scrubber.scrub(key);
          if (Object.hasOwn(entries, scrubbedKey))
            throw new Error('Structured tool output has colliding redacted keys');
          entries[scrubbedKey] = copied;
        }
      }
      result = entries;
    }
    seen.delete(value);
    return result;
  }
  const detached = copy(output, 0);
  if (Buffer.byteLength(JSON.stringify(detached), 'utf8') > MAX_BYTES) {
    throw new Error('Structured tool output exceeds 8 MiB; request a smaller result');
  }
  const value = detached;
  const validation = validateAgainstSchema(value, schema);
  if (!validation.ok)
    throw new Error(
      `Structured tool output does not match its outputSchema (${validation.errors[0]?.path ?? 'root'})`,
    );
  return value;
}

export function rememberProgrammaticOutput(block: ToolResultBlock, value: unknown): void {
  values.set(block, { value, content: block.content });
}

/** Content-changing policies invalidate access to the pre-policy value. */
export function programmaticOutput(block: ToolResultBlock): { value: unknown } | undefined {
  const stored = values.get(block);
  return stored && !block.is_error && stored.content === block.content
    ? { value: stored.value }
    : undefined;
}

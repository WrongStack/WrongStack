import type { Request } from '@wrongstack/core/types';

export type { Request };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks if a value is a Node.js readable stream (has pipe and on methods). */
export function isNodeReadable(b: unknown): boolean {
  return (
    !!b &&
    typeof b === 'object' &&
    typeof (b as { pipe?: unknown | undefined }).pipe === 'function' &&
    typeof (b as { on?: unknown | undefined }).on === 'function'
  );
}

/** Strips `cache_control` from message blocks in a system prompt. */
export function stripCacheControl(system: Request['system']): Request['system'] {
  if (!system) return undefined;
  return system.map((b) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { cache_control: _cc, ...rest } = b;
    return rest;
  });
}

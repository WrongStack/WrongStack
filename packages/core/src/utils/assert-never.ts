/**
 * Exhaustiveness check for discriminated union switches.
 * Place in the `default` branch of a switch over a union type
 * to get a compile-time error when a new variant is added.
 *
 * @example
 * switch (block.type) {
 *   case 'text': return renderText(block);
 *   case 'tool_use': return renderToolUse(block);
 *   default: return assertNever(block);
 * }
 */
export function assertNever(x: never, message?: string): never {
  let serialized: string;
  try {
    serialized = JSON.stringify(x);
  } catch {
    serialized = String(x);
  }
  const err = new Error(message ?? `Unhandled case: ${serialized}`);
  err.name = 'AssertNeverError';
  throw err;
}

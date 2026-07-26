/**
 * Quote a single argument for `cmd.exe` when spawning with `shell: true` on
 * Windows. Only args containing whitespace or quotes need wrapping; inside
 * double quotes cmd.exe escapes a literal `"` as `""`. Backslashes are literal
 * inside cmd quotes, so paths like `C:\Program Files\x` pass through unharmed.
 */
export function quoteWindowsArg(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

const MAX_PROTOCOL_INPUT_CHARS = 8_192;

export function validateProtocolString(
  value: unknown,
  label: string,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`MCP ${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  if (value.length > MAX_PROTOCOL_INPUT_CHARS) {
    throw new Error(`MCP ${label} exceeds ${MAX_PROTOCOL_INPUT_CHARS} characters`);
  }
}

export function pageParams(cursor: string | undefined, label: string): Record<string, string> {
  if (cursor === undefined) return {};
  validateProtocolString(cursor, label);
  return { cursor };
}

export function parseEmptyResult(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed MCP empty result: expected object');
  }
}

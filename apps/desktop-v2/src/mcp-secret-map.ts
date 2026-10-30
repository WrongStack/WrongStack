/**
 * Per-key editing of an MCP connection's environment or HTTP headers without ever holding
 * the stored secrets. The engine shows a secret value as {@link MCP_SECRET_MASK}; sending that
 * mask back means "keep the stored value", a new value replaces it and an omitted key is
 * removed (engines advertising `mcp.masked-headers`).
 */

/** Must match `MCP_ENV_MASK` in `@wrongstack/mcp`. */
export const MCP_SECRET_MASK = '__wrongstack_unchanged__';

export type SecretMapKind = 'env' | 'headers';

export interface SecretMapRow {
  key: string;
  /** What the engine showed: the mask for a hidden value, else the plain value. */
  shown: string;
  action: 'keep' | 'replace' | 'remove';
  value: string;
}

export interface SecretMapAddition {
  key: string;
  value: string;
}

export function secretMapRows(map: Record<string, unknown>): SecretMapRow[] {
  return Object.entries(map).map(([key, shown]) => ({
    key,
    shown: String(shown),
    action: 'keep',
    value: '',
  }));
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_VALUE = 4_096;

/**
 * The whole map to send: kept keys carry what the engine showed (the mask keeps a hidden
 * value), replaced and added keys carry their new value, removed keys are left out. Throws
 * with a message the user can act on.
 */
export function secretMapPayload(
  kind: SecretMapKind,
  rows: readonly SecretMapRow[],
  additions: readonly SecretMapAddition[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  const label = kind === 'env' ? 'Environment variable' : 'Header';
  const claim = (key: string) => {
    // Header names are case-insensitive; environment names are not on every platform.
    const normalized = kind === 'headers' ? key.toLowerCase() : key;
    if (seen.has(normalized)) throw Error(`${label} ${key} appears twice.`);
    seen.add(normalized);
  };
  const checkValue = (key: string, value: string) => {
    if (!value) throw Error(`Enter a value for ${key}, or remove it.`);
    if (value.length > MAX_VALUE)
      throw Error(`The value of ${key} is longer than 4,096 characters.`);
    if (value === MCP_SECRET_MASK) throw Error(`The value of ${key} cannot be the reserved mask.`);
    if (kind === 'headers' && /[\r\n]/.test(value))
      throw Error(`The value of ${key} cannot contain line breaks.`);
  };
  for (const row of rows) {
    if (row.action === 'remove') continue;
    claim(row.key);
    if (row.action === 'replace') {
      checkValue(row.key, row.value);
      out[row.key] = row.value;
    } else out[row.key] = row.shown;
  }
  for (const addition of additions) {
    const key = addition.key.trim();
    if (!key) throw Error(`Every new ${kind === 'env' ? 'variable' : 'header'} needs a name.`);
    if (!(kind === 'env' ? ENV_NAME : HEADER_NAME).test(key))
      throw Error(
        `${key} is not a valid ${kind === 'env' ? 'environment variable' : 'header'} name.`,
      );
    claim(key);
    checkValue(key, addition.value);
    out[key] = addition.value;
  }
  return out;
}

/** Whether anything would change compared with what the engine showed. */
export function secretMapChanged(
  rows: readonly SecretMapRow[],
  additions: readonly SecretMapAddition[],
): boolean {
  return additions.length > 0 || rows.some((row) => row.action !== 'keep');
}

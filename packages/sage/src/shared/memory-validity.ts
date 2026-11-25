import type { MemoryValidity } from '../memory-model.js';

export function normalizeValidity(value: unknown): MemoryValidity | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SAGE validity requires a statement and optional source checks.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !['statement', 'checks'].includes(key)))
    throw new Error('Unknown SAGE validity field.');
  if (typeof v.statement !== 'string' || !v.statement.trim() || v.statement.length > 1000)
    throw new Error('SAGE validity statement must contain 1–1000 characters.');
  if (v.checks !== undefined && (!Array.isArray(v.checks) || v.checks.length > 4))
    throw new Error('SAGE validity supports at most four source checks.');
  const checks = (v.checks as unknown[] | undefined)?.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid SAGE validity check.');
    const c = entry as Record<string, unknown>;
    const rawPath = typeof c.path === 'string' ? c.path.trim() : '';
    if (
      Object.keys(c).some((key) => !['type', 'path', 'text'].includes(key)) ||
      c.type !== 'source_contains' ||
      !rawPath ||
      rawPath.length > 500 ||
      /^[\\/]|^[a-z]:/i.test(rawPath) ||
      rawPath.split(/[\\/]/).some((part) => part === '..') ||
      /[\x00-\x1f]/.test(rawPath) ||
      typeof c.text !== 'string' ||
      !c.text.trim() ||
      c.text.length > 400
    )
      throw new Error(
        'SAGE validity checks require a relative project path and a literal of 1–400 characters.',
      );
    return { type: 'source_contains' as const, path: rawPath.replaceAll('\\', '/'), text: c.text };
  });
  return { statement: v.statement.trim(), ...(checks?.length ? { checks } : {}) };
}

/**
 * Canonical equality key for a validity, used to decide whether a decoded
 * memory and an incoming one describe the same applicability conditions.
 *
 * Unlike {@link normalizeValidity} this NEVER throws. It is called on rows
 * decoded out of the database as well as on validated input, and a stored
 * validity can violate today's rules — an older schema accepted an absolute
 * check path, a hand-edit can introduce one, and `validateMemoryShape`
 * deliberately does not inspect optional fields. Throwing escaped the
 * caller's skip-corrupt-row loop (e.g. `rememberSqliteSage`) and failed an
 * unrelated write, which is exactly what that loop exists to prevent.
 *
 * An unusable value therefore falls back to a raw-shape key. It is prefixed
 * and array-shaped so it can never equal a normalized key (`normalizeValidity`
 * only ever yields an object or `null`): the row then simply does not match
 * for dedupe, instead of failing the operation.
 */
export function validityKey(value: MemoryValidity | undefined): string {
  try {
    return JSON.stringify(normalizeValidity(value) ?? null);
  } catch {
    try {
      return JSON.stringify(['\u0000invalid', value ?? null]);
    } catch {
      return JSON.stringify(['\u0000invalid', '[Unserializable]']);
    }
  }
}

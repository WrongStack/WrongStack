// ---------------------------------------------------------------------------
// JMESPath implementation (from json-path plugin)
// ---------------------------------------------------------------------------

function ownProp(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

export function jmespathSearch(data: unknown, query: string): unknown {
  // Handle basic JMESPath expressions
  if (!query || query === '@') return data;

  // Root access
  if (query === '$') return data;

  // Dot notation: foo.bar
  const dotMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\.(.+))?$/);
  if (dotMatch) {
    const key = dotMatch[1]!;
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return undefined;
    }
    const rest = dotMatch[2];
    const val = ownProp(data, key);
    if (rest === undefined) return val;
    return jmespathSearch(val, rest);
  }

  // Property indexing: foo[0], foo[0].bar, foo[0][1]
  const propIdxMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\](?:\.?(.*))?$/);
  if (propIdxMatch) {
    const key = propIdxMatch[1]!;
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return undefined;
    }
    const idx = Number.parseInt(propIdxMatch[2]!, 10);
    const rest = propIdxMatch[3] ? propIdxMatch[3] : undefined;
    const arr = ownProp(data, key);
    if (!Array.isArray(arr)) return undefined;
    const val = arr[idx];
    if (rest === undefined) return val;
    return jmespathSearch(val, rest);
  }

  // Array access: [0], [0].rest, or [0][1]
  const arrMatch = query.match(/^\[(\d+)\](?:\.?(.*))?$/);
  if (arrMatch) {
    if (!Array.isArray(data)) return undefined;
    const idx = Number.parseInt(arrMatch[1]!, 10);
    const rest = arrMatch[2] ? arrMatch[2] : undefined;
    const val = data[idx];
    if (rest === undefined) return val;
    return jmespathSearch(val, rest);
  }

  // Wildcard: [*] or [*].rest
  const wildcardMatch = query.match(/^\[\*\](?:\.(.+))?$/);
  if (wildcardMatch) {
    if (!Array.isArray(data)) return [];
    const rest = wildcardMatch[1];
    if (rest === undefined) return data;
    return data.map((item) => jmespathSearch(item, rest));
  }

  // Multi-select: foo.bar[*].baz
  const multiMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[\*\](?:\.(.+))?$/);
  if (multiMatch) {
    const key = multiMatch[1]!;
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return [];
    }
    const rest = multiMatch[2];
    const arr = ownProp(data, key);
    if (!Array.isArray(arr)) return [];
    if (rest === undefined) return arr;
    return arr.map((item) => jmespathSearch(item, rest));
  }

  // Filter: [?foo==`bar`]
  const filterMatch = query.match(
    /^\[\??([a-zA-Z_][a-zA-Z0-9_]*)(==|!=|<|>|<=|>=)(`[^`]+`|'[^']*')\](?:\.(.+))?$/,
  );
  if (filterMatch) {
    const field = filterMatch[1]!;
    if (field === '__proto__' || field === 'prototype' || field === 'constructor') {
      return [];
    }
    const op = filterMatch[2]!;
    const rawVal = filterMatch[3]!;
    const rest = filterMatch[4];
    let cmpVal: unknown;
    if (rawVal.startsWith("'") && rawVal.endsWith("'")) {
      cmpVal = rawVal.slice(1, -1);
    } else {
      const inner = rawVal.slice(1, -1);
      try {
        cmpVal = JSON.parse(inner);
      } catch {
        cmpVal = inner;
      }
    }
    const arr = data as Record<string, unknown>[];
    if (!Array.isArray(arr)) return [];
    const filtered = arr.filter((item) => {
      // A `null` element (valid JSON) has no fields: JMESPath reads it as null
      // instead of failing the whole query.
      const itemVal = ownProp(item, field);
      // Ordering is number-only in JMESPath; coercion would select nulls,
      // booleans, numeric strings and arrays as if they were numeric fields.
      if (
        op !== '==' &&
        op !== '!=' &&
        (typeof itemVal !== 'number' || typeof cmpVal !== 'number')
      ) {
        return false;
      }
      switch (op) {
        case '==':
          return itemVal === cmpVal;
        case '!=':
          return itemVal !== cmpVal;
        case '>':
          return Number(itemVal) > Number(cmpVal);
        case '<':
          return Number(itemVal) < Number(cmpVal);
        case '>=':
          return Number(itemVal) >= Number(cmpVal);
        case '<=':
          return Number(itemVal) <= Number(cmpVal);
        /* v8 ignore next -- op is constrained to the six operators by the filter regex; default is unreachable. */
        default:
          return true;
      }
    });
    if (rest === undefined) return filtered;
    return filtered.map((item) => jmespathSearch(item, rest));
  }

  // Function calls: length(@)
  const fnMatch = query.match(/^(length|keys|values|type)\(@\)$/);
  if (fnMatch) {
    const fn = fnMatch[1]!;
    switch (fn) {
      case 'length':
        if (Array.isArray(data)) return data.length;
        if (typeof data === 'string') return data.length;
        if (typeof data === 'object' && data !== null) return Object.keys(data as object).length;
        return 0;
      case 'keys':
        if (typeof data === 'object' && data !== null && !Array.isArray(data))
          return Object.keys(data as object);
        return [];
      case 'values':
        if (typeof data === 'object' && data !== null && !Array.isArray(data))
          return Object.values(data as object);
        return [];
      case 'type':
        if (data === null) return 'null';
        if (Array.isArray(data)) return 'array';
        return typeof data;
      /* v8 ignore next 2 -- fn is constrained to the four names by the function regex; default is unreachable. */
      default:
        return null;
    }
  }

  // No shape matched — a question about the query TEXT, never the data. A
  // `null` here was reported as `query_result: null`, indistinguishable from a
  // real null at that path, so standard JMESPath this subset does not parse
  // (`items[?price > \`10\`]`, `length(items)`, `"a-b"`) read as an answer.
  throw new Error(
    `unsupported query syntax "${query}" — supported: a.b, a[0], [0], [*], a[*].b, ` +
      '[?field==`value`] (no spaces), length|keys|values|type(@)',
  );
}

// ---------------------------------------------------------------------------
// Simple path-based query (original json tool query, backward compat)
// ---------------------------------------------------------------------------

export function simpleQuery(data: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (part === '__proto__' || part === 'prototype' || part === 'constructor') {
      return undefined;
    }

    const idx = Number(part);
    if (!Number.isNaN(idx) && Array.isArray(current)) {
      current = current[idx];
    } else if (typeof current === 'object' && current !== null) {
      current = ownProp(current, part);
    } else {
      return undefined;
    }
  }

  return current;
}

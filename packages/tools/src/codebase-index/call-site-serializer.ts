import type { CallSite } from './schema.js';

/** Share identical symbol metadata while preserving every edge in its original order. */
export function serializeCallSites<T extends { calls: CallSite[] }>(output: T): string {
  const { calls, ...metadata } = output;
  const symbols: CallSite['symbol'][] = [];
  const indexes = new Map<string, number>();
  const edges = calls.map(({ symbol, ...edge }) => {
    // Identity alone is insufficient: retain conflicting metadata as separate entries.
    const key = JSON.stringify(symbol);
    let symbolIndex = indexes.get(key);
    if (symbolIndex === undefined) {
      symbolIndex = symbols.length;
      indexes.set(key, symbolIndex);
      symbols.push(symbol);
    }
    return { symbolIndex, ...edge };
  });
  return JSON.stringify({ ...metadata, symbols, calls: edges });
}

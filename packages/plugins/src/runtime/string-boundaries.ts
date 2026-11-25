export function nonnegativeFiniteLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function safePrefix(value: string, max: number): string {
  const limit = nonnegativeFiniteLimit(max);
  let end = Math.min(value.length, limit);
  const lastKept = value.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

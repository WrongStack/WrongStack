export function safePrefix(value: string, max: number): string {
  let end = Math.min(value.length, Math.max(0, Math.floor(max)));
  const lastKept = value.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export function safeSuffix(value: string, max: number): string {
  let start = Math.max(0, value.length - Math.max(0, Math.floor(max)));
  const firstKept = value.charCodeAt(start);
  if (firstKept >= 0xdc00 && firstKept <= 0xdfff) start += 1;
  return value.slice(start);
}

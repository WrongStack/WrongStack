export function shouldSkipSessionDirectoryEntry(name: string): boolean {
  return (
    (name.startsWith('.') && name !== '.wrongstack') ||
    name === 'shared' ||
    name === 'subagents' ||
    name === 'attachments'
  );
}

export function isSessionJsonlFileName(name: string): boolean {
  return name.endsWith('.jsonl') && name !== '_index.jsonl';
}

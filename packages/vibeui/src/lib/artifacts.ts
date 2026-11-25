const text = (value: unknown) => (typeof value === 'string' ? value : '');

export interface Artifact {
  id: string;
  sessionId: string;
  path: string;
  title: string;
  kind: 'text' | 'image' | 'diff';
}

/** VibeUI intentionally previews only passive text, image and diff artifacts. */
export function parseArtifact(output: string, sessionId: string): Artifact | null {
  if (output.length > 16384) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      value.type !== 'artifact.presentation' ||
      (value.version !== 1 && value.version !== 2) ||
      value.sessionId !== sessionId
    )
      return null;
    const kind = value.version === 1 ? 'text' : value.kind;
    if (kind !== 'text' && kind !== 'image' && kind !== 'diff') return null;
    const path = text(value.path);
    if (
      !path ||
      path.length > 4096 ||
      /[\\:\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return null;
    const id = text(value.id);
    const title = text(value.title);
    if (!id || id.length > 128 || !title || title.length > 160) return null;
    return { id, sessionId, path, title, kind };
  } catch {
    return null;
  }
}

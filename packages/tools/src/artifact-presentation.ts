/** Browser-safe result contract for present_artifact. */
export interface ArtifactPresentation {
  type: 'artifact.presentation';
  version: 1 | 2;
  id: string;
  sessionId: string;
  path: string;
  title: string;
  kind?: 'text' | 'image' | 'diff' | 'browser' | undefined;
  browserSessionId?: string | undefined;
}

export function parseArtifactPresentation(output: unknown): ArtifactPresentation | null {
  let value: unknown = output;
  if (typeof value === 'string') {
    if (value.length > 16_384) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (p['type'] !== 'artifact.presentation' || (p['version'] !== 1 && p['version'] !== 2))
    return null;
  if (
    p['version'] === 2 &&
    (typeof p['kind'] !== 'string' || !['text', 'image', 'diff', 'browser'].includes(p['kind']))
  )
    return null;
  if (
    p['kind'] === 'browser' &&
    (typeof p['browserSessionId'] !== 'string' || !/^[\w-]{1,128}$/.test(p['browserSessionId']))
  )
    return null;
  for (const field of ['id', 'sessionId', 'path', 'title']) {
    if (typeof p[field] !== 'string' || !p[field].trim() || /[\x00-\x1f\x7f]/.test(p[field]))
      return null;
  }
  const filePath = (p['path'] as string).trim();
  if (
    filePath.length > 4096 ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath.includes(':') ||
    filePath.split('/').some((part) => !part || part === '..' || part === '.') ||
    (p['title'] as string).length > 160 ||
    (p['sessionId'] as string).length > 256 ||
    (p['id'] as string).length > 128
  )
    return null;
  return {
    type: 'artifact.presentation',
    version: p['version'] as 1 | 2,
    id: p['id'] as string,
    sessionId: p['sessionId'] as string,
    path: filePath,
    title: p['title'] as string,
    ...(p['version'] === 2
      ? {
          kind: p['kind'] as ArtifactPresentation['kind'],
          ...(p['kind'] === 'browser' ? { browserSessionId: p['browserSessionId'] as string } : {}),
        }
      : {}),
  };
}

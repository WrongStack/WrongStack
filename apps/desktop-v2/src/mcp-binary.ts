/** Raster images only: SVG is markup and is not rendered from external content. */
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

export interface McpBinary {
  mimeType: string;
  base64: string;
  bytes: Uint8Array<ArrayBuffer>;
  previewable: boolean;
}

/**
 * The binary payload of an MCP resource (`blob`) or prompt content (`data`) block, decoded
 * strictly; malformed base64 is reported instead of guessed.
 */
export function mcpBinary(value: Record<string, unknown>): McpBinary | { error: string } | null {
  const raw = typeof value['blob'] === 'string' ? value['blob'] : value['data'];
  if (typeof raw !== 'string') return null;
  const base64 = raw.replace(/\s+/g, '');
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
    return { error: 'The binary content is not valid base64.' };
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  const mimeType =
    typeof value['mimeType'] === 'string' && value['mimeType']
      ? value['mimeType'].toLowerCase()
      : 'application/octet-stream';
  return { mimeType, base64, bytes, previewable: PREVIEWABLE.has(mimeType) };
}

/** A file name from the resource URI's last segment, safe on every platform. */
export function mcpBinaryFileName(uri: unknown, mimeType: string): string {
  const segment =
    typeof uri === 'string' ? (uri.split(/[?#]/)[0]!.split('/').filter(Boolean).pop() ?? '') : '';
  let name = '';
  try {
    name = decodeURIComponent(segment);
  } catch {
    name = segment;
  }
  name = name
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 100);
  if (!name || name.includes(':')) name = 'mcp-content';
  const extension = EXTENSIONS[mimeType] ?? 'bin';
  return /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}.${extension}`;
}

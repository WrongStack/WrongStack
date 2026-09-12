import type { Location, LocationLink } from 'vscode-languageserver-protocol';
import { displayPath, uriToPath } from '../utils/uri.js';

export function formatLocations(
  locations: Array<Location | LocationLink> | null,
  cwd: string,
  limit = 100,
): string {
  if (!locations || locations.length === 0) return 'No locations found.';
  const lines = locations.slice(0, limit).map((loc) => {
    const uri = 'uri' in loc ? loc.uri : loc.targetUri;
    const range = 'range' in loc ? loc.range : loc.targetSelectionRange;
    return `${displayUri(uri, cwd)}:${range.start.line + 1}:${range.start.character + 1}`;
  });
  if (locations.length > limit) lines.push(`... truncated ${locations.length - limit} more`);
  return lines.join('\n');
}

/**
 * A definition/reference target is usually a `file:` URI, but some servers
 * answer with a custom scheme (`jdt:`, `vscode-remote:`). `fileURLToPath`
 * throws on every one of those, which aborted the whole result; fall back to
 * the URI verbatim so the location is still reported.
 */
function displayUri(uri: string, cwd: string): string {
  try {
    return displayPath(uriToPath(uri), cwd);
  } catch {
    /* v8 ignore next -- non-file/unparseable URIs are server-specific. */
    return uri;
  }
}

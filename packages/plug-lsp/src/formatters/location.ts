import type { Location, LocationLink } from 'vscode-languageserver-protocol';
import { displayPath, uriToPathOrUri } from '../utils/uri.js';

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
 * answer with a custom scheme (`jdt:`, `vscode-remote:`). Those cannot be
 * mapped to a path, so fall back to the URI verbatim instead of aborting the
 * whole result.
 */
function displayUri(uri: string, cwd: string): string {
  const resolved = uriToPathOrUri(uri);
  return uri.startsWith('file:') ? displayPath(resolved, cwd) : resolved;
}

import type { Location, LocationLink } from 'vscode-languageserver-protocol';
import { lspColumnToHuman } from '../position.js';
import { displayPath, uriToPathOrUri } from '../utils/uri.js';

/** Text of one 0-based line of a file, when it can be read. */
export type LineTextReader = (filePath: string, line: number) => string | undefined;

export function formatLocations(
  locations: Location | LocationLink | Array<Location | LocationLink> | null,
  cwd: string,
  limit = 100,
  lineText?: LineTextReader,
): string {
  if (!locations) return 'No locations found.';
  const list = Array.isArray(locations) ? locations : [locations];
  if (list.length === 0) return 'No locations found.';
  const effectiveLimit =
    typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 100;
  const lines = list.slice(0, effectiveLimit).map((loc) => {
    const uri = 'uri' in loc ? loc.uri : loc.targetUri;
    const range = 'range' in loc ? loc.range : loc.targetSelectionRange;
    const safeLine =
      typeof range.start.line === 'number' && Number.isFinite(range.start.line)
        ? Math.max(0, Math.trunc(range.start.line))
        : 0;
    const safeChar =
      typeof range.start.character === 'number' && Number.isFinite(range.start.character)
        ? Math.max(0, Math.trunc(range.start.character))
        : 0;
    // Columns go out in the same 1-based byte convention the tools take in,
    // so a location can be passed straight back to hover/definition/rename.
    const text = /^file:/i.test(uri) ? lineText?.(uriToPathOrUri(uri), safeLine) : undefined;
    const column = text !== undefined ? lspColumnToHuman(text, safeChar) : safeChar + 1;
    return `${displayUri(uri, cwd)}:${safeLine + 1}:${column}`;
  });
  if (list.length > effectiveLimit)
    lines.push(`... truncated ${list.length - effectiveLimit} more`);
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
  return /^file:/i.test(uri) ? displayPath(resolved, cwd) : resolved;
}

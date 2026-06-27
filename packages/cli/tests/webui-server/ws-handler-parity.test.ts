import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WS-handler parity guard.
 *
 * There are two WebUI servers that drive the same browser client over the same
 * `WSClientMessage` protocol:
 *   - CLI-embedded  (`wrongstack --webui`) — packages/cli/src/webui-server.ts
 *   - standalone    (`wstackui`)           — packages/webui/src/server/index.ts
 *
 * Historically they drifted: a message type handled by one but not the other
 * silently breaks that surface (e.g. the embedded server once punted ALL
 * `mcp.*` writes). This test extracts the `case '<type>'` labels from each
 * server's single `switch (msg.type)` and asserts the two sets are identical,
 * so any future handler added to one server but not the other fails CI loudly.
 *
 * `autophase.*` and `collab.*` are intentionally NOT in these switches — both
 * servers route them to dedicated handlers (`AutoPhaseWebSocketHandler` /
 * `CollaborationWebSocketHandler`) via a `msg.type.startsWith(...)` check before
 * the switch, so their absence here is correct and symmetric.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const typesFile = path.join(repoRoot, 'packages/webui/src/types.ts');
const embeddedPath = path.join(repoRoot, 'packages/cli/src/webui-server.ts');
const standalonePaths = [
  path.join(repoRoot, 'packages/webui/src/server/index.ts'),
  path.join(repoRoot, 'packages/webui/src/server/provider-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/session-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/project-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/mode-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/shell-git-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/mailbox-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/brain-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/autophase-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/specs-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/sdd-board-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/sdd-wizard-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/mcp-routes.ts'),
  path.join(repoRoot, 'packages/webui/src/server/prefs-routes.ts'),
];

/** Extract the set of dispatched message-type labels from one or more source
 * files. Supports two formats:
 *  - `case '<label>':` — a switch statement
 *  - `'<label>':` / `<label>:` — a route-map object literal key inside `wsRoutes`
 */
function caseLabels(files: string | readonly string[]): Set<string> {
  const labels = new Set<string>();
  for (const file of Array.isArray(files) ? files : [files]) {
    const src = fs.readFileSync(file, 'utf8');
    // switch-case labels: `case 'foo':`
    for (const m of src.matchAll(/case\s+'([^']+)'\s*:/g)) {
      labels.add(m[1] as string);
    }
    // route-map object-literal keys: `'foo':` inside a wsRoutes = { ... } block
    const routesStart = src.indexOf('wsRoutes');
    if (routesStart !== -1) {
      const braceStart = src.indexOf('{', routesStart);
      if (braceStart !== -1) {
        let depth = 0;
        let endIdx = braceStart;
        for (let i = braceStart; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }
        const block = src.slice(braceStart + 1, endIdx);
        let routeDepth = 1;
        for (const line of block.split(/\r?\n/)) {
          if (routeDepth === 1) {
            const m = line.match(/^\s*(?:'([a-z][a-zA-Z0-9_.]*)'|([a-z][a-zA-Z0-9_.]*))\s*:/);
            if (m) labels.add((m[1] ?? m[2]) as string);
          }
          for (const ch of line) {
            if (ch === '{') routeDepth++;
            else if (ch === '}') routeDepth--;
          }
        }
      }
    }
  }
  return labels;
}

/**
 * Message-family prefixes a server delegates wholesale via
 * `msg.type.startsWith('<family>.')` BEFORE its switch (e.g. `autophase.`).
 * Only dotted prefixes count — a stray `startsWith('session-registry.json')`
 * (a file-watch check) is not a message family and is dropped.
 */
function delegatedPrefixes(files: string | readonly string[]): Set<string> {
  const prefixes = new Set<string>();
  for (const file of Array.isArray(files) ? files : [files]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/startsWith\('([^']+)'\)/g)) {
      const p = m[1] as string;
      if (p.endsWith('.')) prefixes.add(p);
    }
  }
  return prefixes;
}

/**
 * The canonical set of client→server message types: every discriminant in the
 * `WSClientMessage` union in types.ts — inline `{ type: '…' }` members plus the
 * discriminant of each named alias member (`| WSUserMessage`, `| WSCollabJoin`).
 * Derived from source so it self-updates when the union changes.
 */
function canonicalClientTypes(): Set<string> {
  const src = fs.readFileSync(typesFile, 'utf8');
  const start = src.indexOf('export type WSClientMessage =');
  if (start === -1) throw new Error('WSClientMessage union not found in types.ts');
  const after = src.indexOf('\nexport ', start + 'export type WSClientMessage ='.length);
  const block = src.slice(start, after === -1 ? undefined : after);

  const types = new Set<string>();
  for (const m of block.matchAll(/type:\s*'([^']+)'/g)) types.add(m[1] as string);
  for (const m of block.matchAll(/\|\s*(WS[A-Za-z0-9_]+)\b/g)) {
    const alias = m[1] as string;
    const defIdx = src.search(new RegExp(`(?:type|interface)\\s+${alias}\\b`));
    if (defIdx === -1) continue;
    const d = src.slice(defIdx, defIdx + 400).match(/type:\s*'([^']+)'/);
    if (d) types.add(d[1] as string);
  }
  return types;
}

/** A type is handled by a server if it's a `case` label or covered by a delegated prefix. */
function isHandled(type: string, cases: Set<string>, prefixes: Set<string>): boolean {
  if (cases.has(type)) return true;
  for (const p of prefixes) if (type.startsWith(p)) return true;
  return false;
}

/**
 * Union members present in the frontend's `WSClientMessage` but dispatched by
 * NEITHER server — incomplete features, intentionally unimplemented. Currently
 * empty: every client message type is handled by at least one server (the
 * standalone routes collab.grant_control / collab.inject_tool to the real
 * CollaborationWebSocketHandler; the CLI no-ops collab). If a NEW union type
 * lands unhandled by both servers, the union-coverage test fails until it's
 * wired or listed here.
 */
const KNOWN_UNIMPLEMENTED: string[] = [];
const NON_WS_CASE_LABELS = new Set(['absent', 'live', 'probe-failed']);

describe('WebUI WS-handler parity (embedded vs standalone)', () => {
  it('both server files exist and have message-type cases', () => {
    expect(fs.existsSync(embeddedPath)).toBe(true);
    for (const standalonePath of standalonePaths) {
      expect(fs.existsSync(standalonePath)).toBe(true);
    }
    expect(caseLabels(embeddedPath).size).toBeGreaterThan(50);
    expect(caseLabels(standalonePaths).size).toBeGreaterThan(50);
  });

  it('handles an identical set of WS message types in both servers', () => {
    const embedded = caseLabels(embeddedPath);
    const standalone = caseLabels(standalonePaths);

    const onlyEmbedded = [...embedded].filter((t) => !standalone.has(t)).sort();
    const onlyStandalone = [...standalone]
      .filter((t) => !embedded.has(t) && !NON_WS_CASE_LABELS.has(t))
      .sort();

    // If this fails, a message handler was added to one server but not the
    // other. Add the matching `case` to the other server (or, for messages
    // routed by a dedicated startsWith handler, ensure both route it).
    expect({ onlyEmbedded, onlyStandalone }).toEqual({
      onlyEmbedded: [],
      onlyStandalone: [],
    });
  });

  // The parity test above guards RELATIVE drift (embedded == standalone). This
  // one guards ABSOLUTE coverage: a brand-new `WSClientMessage` type wired into
  // NEITHER server would keep the two sets identical (both miss it) yet silently
  // no-op in the browser. Here we assert every union member is actually
  // dispatched by both servers, except a documented unimplemented allowlist.
  it('handles every WSClientMessage union member in both servers (union coverage)', () => {
    const canon = canonicalClientTypes();
    expect(canon.size).toBeGreaterThan(100);

    const embeddedCases = caseLabels(embeddedPath);
    const standaloneCases = caseLabels(standalonePaths);
    const embeddedPrefixes = delegatedPrefixes(embeddedPath);
    const standalonePrefixes = delegatedPrefixes(standalonePaths);

    const unhandledBy = (cases: Set<string>, prefixes: Set<string>): string[] =>
      [...canon].filter((t) => !isHandled(t, cases, prefixes)).sort();

    // Anything unhandled beyond the documented allowlist = a real gap: the
    // frontend can send it but no server acts on it.
    expect(unhandledBy(embeddedCases, embeddedPrefixes)).toEqual(KNOWN_UNIMPLEMENTED);
    expect(unhandledBy(standaloneCases, standalonePrefixes)).toEqual(KNOWN_UNIMPLEMENTED);
  });

  // The two tests above only scan the files in `standalonePaths`. The standalone
  // server's primary dispatch lives in `index.ts` + the `*-routes.ts` modules (by
  // convention; `*-handlers.ts` / `*-ws-handler.ts` are delegated handler bodies
  // whose primary `case` is in index.ts). If a NEW `*-routes.ts` module is added
  // but not listed here, its cases go unscanned and drift inside it slips past the
  // guards above. This keeps `standalonePaths` honest against the files on disk.
  it('scans every *-routes.ts dispatch module (standalonePaths is complete)', () => {
    const serverDir = path.join(repoRoot, 'packages/webui/src/server');
    const onDisk = fs
      .readdirSync(serverDir)
      .filter((f) => f.endsWith('-routes.ts'))
      .map((f) => path.join(serverDir, f))
      .sort();
    const listed = standalonePaths.filter((p) => p.endsWith('-routes.ts')).sort();
    expect(listed).toEqual(onDisk);
  });
});

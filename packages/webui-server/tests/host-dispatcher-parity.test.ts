/**
 * The two WS hosts must route the same protocol.
 *
 * `message-dispatcher.ts` serves the standalone `wstack webui` server;
 * `embedded-message-router.ts` serves the WebUI embedded in the CLI. A browser
 * cannot tell them apart, so every message type it may send has to be routed by
 * both. They already share `createRouteFamilyDispatcher`, which makes the
 * route-family list the contract — and the pre-dispatch chain in front of it
 * the place drift hides, because those handlers are wired by hand, one `if`
 * per host.
 *
 * That is exactly what happened: `handleConnectionsServiceAction` was wired
 * only into the embedded router. On the standalone server the browser sent
 * `connections.service_action`, no handler claimed it, no
 * `connections.service_action_result` came back, and the Settings →
 * Connections row sat pending forever. Nothing failed loudly — the two hosts
 * do not even agree on what an unrouted message means (standalone replies with
 * an `error` frame, embedded writes a `console.debug` line and drops it), so on
 * the embedded host a missing handler is silent by construction.
 *
 * Textual comparison is deliberate. The wiring is what drifts, and the wiring
 * is only observable at the call site: both factories need a large live
 * dependency graph to instantiate, so a runtime comparison would test the
 * mocks. This reads the two source files and holds their wiring to the same
 * shape.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server');

const STANDALONE = 'message-dispatcher.ts';
const EMBEDDED = 'embedded-message-router.ts';

/**
 * Strip comments and string bodies so brace-matching and key extraction do not
 * trip over `//` inside a URL, a `{` inside a doc comment, or a `,` inside a
 * message-type literal.
 */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** The balanced `{...}` block that follows `marker`, exclusive of the braces. */
function balancedBlockAfter(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf('{', at + marker.length);
  if (open === -1) throw new Error(`no object literal after: ${marker}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block after: ${marker}`);
}

/** Top-level keys of an object-literal body (shorthand and `key:` alike). */
function topLevelKeys(body: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  let segmentStart = 0;
  const segments: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      segments.push(body.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }
  segments.push(body.slice(segmentStart));
  for (const segment of segments) {
    const name = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(segment);
    if (name?.[1]) keys.add(name[1]);
  }
  return keys;
}

/** Route-family keys handed to `createRouteFamilyDispatcher`. */
function routeFamilies(file: string): Set<string> {
  const source = stripNoise(readFileSync(path.join(SERVER_DIR, file), 'utf8'));
  const call = balancedBlockAfter(source, 'createRouteFamilyDispatcher(');
  return topLevelKeys(balancedBlockAfter(call, 'routes:'));
}

/** `handleXxx(...)` calls in the returned dispatcher, ahead of `dispatch()`. */
function preDispatchHandlers(file: string): Set<string> {
  const source = stripNoise(readFileSync(path.join(SERVER_DIR, file), 'utf8'));
  const at = source.lastIndexOf('return async (');
  expect(at, `${file}: no returned dispatcher found`).toBeGreaterThan(-1);
  const tail = source.slice(at);
  const found = new Set<string>();
  for (const m of tail.matchAll(/await\s+(handle[A-Z][\w$]*)\s*\(/g)) {
    if (m[1]) found.add(m[1]);
  }
  return found;
}

/**
 * Wiring that is legitimately host-specific, with the reason. An entry here is
 * a decision; anything else is drift.
 */
const HOST_SPECIFIC_FAMILIES: Record<string, string> = {};

describe('WS host dispatcher parity', () => {
  it('both hosts register the same route families', () => {
    const standalone = routeFamilies(STANDALONE);
    const embedded = routeFamilies(EMBEDDED);

    const missingFromStandalone = [...embedded].filter(
      (k) => !standalone.has(k) && !(k in HOST_SPECIFIC_FAMILIES),
    );
    const missingFromEmbedded = [...standalone].filter(
      (k) => !embedded.has(k) && !(k in HOST_SPECIFIC_FAMILIES),
    );

    expect(
      missingFromStandalone,
      `${EMBEDDED} routes these families but ${STANDALONE} does not: ` +
        `${missingFromStandalone.join(', ')}`,
    ).toEqual([]);
    expect(
      missingFromEmbedded,
      `${STANDALONE} routes these families but ${EMBEDDED} does not: ` +
        `${missingFromEmbedded.join(', ')}`,
    ).toEqual([]);
  });

  it('both hosts run the same pre-dispatch handler chain', () => {
    const standalone = preDispatchHandlers(STANDALONE);
    const embedded = preDispatchHandlers(EMBEDDED);

    // The chain is short and hand-wired; both sets should be identical.
    expect([...standalone].sort()).toEqual([...embedded].sort());
    // Guard the extractor: an empty comparison would pass vacuously.
    expect(standalone.size).toBeGreaterThanOrEqual(3);
  });

  it('the pre-dispatch chain still covers connections.service_action', () => {
    for (const file of [STANDALONE, EMBEDDED]) {
      expect(
        preDispatchHandlers(file).has('handleConnectionsServiceAction'),
        `${file} dropped handleConnectionsServiceAction — the browser's ` +
          `connections.service_action would go unanswered on this host`,
      ).toBe(true);
    }
  });

  it('the host-specific allow-list has no stale entries', () => {
    const standalone = routeFamilies(STANDALONE);
    const embedded = routeFamilies(EMBEDDED);
    for (const [key, reason] of Object.entries(HOST_SPECIFIC_FAMILIES)) {
      expect(reason.length, `${key} needs a stated reason`).toBeGreaterThan(10);
      expect(
        standalone.has(key) !== embedded.has(key),
        `${key} is now wired on both hosts — drop it from HOST_SPECIFIC_FAMILIES`,
      ).toBe(true);
    }
  });
});

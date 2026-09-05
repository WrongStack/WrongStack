import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A seam that is handed a session id must declare the parameter.
 *
 * TypeScript accepts a function with FEWER parameters wherever one with more
 * is expected, so `() => …` satisfies `(sessionId?: string) => …` and drops
 * the id the caller pushed — silently. The answer becomes "whatever session
 * this process is on", which on a single-session host is right and with four
 * WebUI tabs open is wrong three times out of four.
 *
 * Every instance so far has been the same one-character mistake:
 *
 *   - `isRunActive: () => abortControllers.size > 0` — one running tab made
 *     all four report busy, so `session.delete` refused forever and every tab
 *     showed a spinner;
 *   - `getSession: () => context.context.session` — a tab's `mode_changed`
 *     entry went into another tab's journal;
 *   - `afterSwitch: async (id) => …` — a mode switch in a background tab
 *     re-announced the LEADER's session carrying the new mode, relabelling a
 *     conversation the user had not touched.
 *
 * Types cannot express "you must take this argument", so the rule is here:
 * a scan of the host wiring for a seam bound to a callable that declares
 * fewer parameters than the contract passes it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');

/** Wiring files where a host hands its own implementations to a shared body. */
const WIRING = [
  'packages/webui-server/src/server/routes.ts',
  'packages/webui-server/src/server/mode-handlers.ts',
  'packages/webui-server/src/server/embedded-message-router.ts',
  'packages/cli/src/webui-server/route-contexts.ts',
  'packages/cli/src/webui-server.ts',
];

/** Seam name → how many parameters the contract actually passes it. */
const SEAMS: Record<string, number> = {
  isRunActive: 1,
  abortActiveRun: 1,
  isSessionLive: 1,
  getAgent: 1,
  peekAgent: 1,
  hasSession: 1,
  getMaxIterations: 1,
  getSessionContext: 1,
  metaForSession: 1,
  getDesignContext: 1,
  // `(id, sessionId)` — the mode being switched, and the tab switching it.
  applyModeId: 2,
  afterSwitch: 2,
};

/**
 * Parameters declared by the arrow function bound to `name:` in `text`.
 *
 * Returns one entry per binding found. A binding to a plain identifier
 * (`isRunActive: someFn`) is not inspected — the definition it points at is
 * checked wherever that lives, and guessing here would be noise.
 */
function boundArities(text: string, name: string): Array<{ line: number; params: number }> {
  const out: Array<{ line: number; params: number }> = [];
  // `name: (a, b) =>` or `name: async (a, b) =>` or `name(a, b) {`
  const re = new RegExp(`\\b${name}\\s*:\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*(?::[^=]*)?=>`, 'g');
  let match: RegExpExecArray | null = re.exec(text);
  for (; match !== null; match = re.exec(text)) {
    const raw = (match[1] ?? '').trim();
    const params = raw === '' ? 0 : raw.split(',').filter((part) => part.trim() !== '').length;
    out.push({ line: text.slice(0, match.index).split('\n').length, params });
  }
  return out;
}

describe('session-aware seams keep their sessionId parameter', () => {
  it('inspects the wiring files it names', () => {
    // A path that stopped existing would make the rule below vacuous.
    for (const rel of WIRING) {
      expect(fs.existsSync(path.join(REPO, rel)), `${rel} is missing`).toBe(true);
    }
    // …and the scanner has to actually find bindings in them.
    const router = fs.readFileSync(
      path.join(REPO, 'packages/webui-server/src/server/embedded-message-router.ts'),
      'utf8',
    );
    expect(boundArities(router, 'afterSwitch').length).toBeGreaterThan(0);
  });

  it('never binds one to a callable that drops it', () => {
    const dropped: string[] = [];
    for (const rel of WIRING) {
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
      for (const [seam, arity] of Object.entries(SEAMS)) {
        for (const found of boundArities(text, seam)) {
          if (found.params >= arity) continue;
          dropped.push(`${rel}:${found.line}  ${seam} takes ${found.params} of ${arity}`);
        }
      }
    }
    expect(
      dropped,
      'declare the parameter even when unused (`_sessionId`) — an omitted one is not a no-op, ' +
        'it silently answers for whichever session the runtime is currently on',
    ).toEqual([]);
  });
});

/**
 * The run-lock registry has no "current" entry.
 *
 * `get`/`set` used to accept the session id as OPTIONAL, fronted by a
 * `_runLockSession` pointer that answered the zero-argument form with
 * whichever tab had most recently started a run. With four tabs running in
 * parallel that is nobody in particular: a zero-argument `set` registered the
 * controller under the wrong tab (so `isRunActive` reported that tab idle and
 * the other busy), and a zero-argument `get` handed back a stranger's
 * controller to abort.
 *
 * The interface now requires the id, but TypeScript still accepts an
 * implementation that declares fewer parameters — so the shape is pinned here
 * as well as in the type.
 */
describe('run locks are keyed by conversation, never by "the current one"', () => {
  const RUNTIME_FILE = 'packages/webui-server/src/server/start-webui-session-runtime.ts';

  function runLockBody(): string {
    const text = fs.readFileSync(path.join(REPO, RUNTIME_FILE), 'utf8');
    const open = text.indexOf('export function createRunLockControl(');
    expect(open, `${RUNTIME_FILE} no longer declares createRunLockControl`).toBeGreaterThan(-1);
    const start = text.indexOf('{', open);
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    throw new Error('unterminated createRunLockControl');
  }

  it('takes the session id on both accessors', () => {
    const body = runLockBody();
    const get = boundArities(body, 'get');
    const set = boundArities(body, 'set');
    // `every` over nothing is true — prove the scanner found the bindings
    // before believing what it says about them.
    expect(get.length, 'no `get:` binding found').toBeGreaterThan(0);
    expect(set.length, 'no `set:` binding found').toBeGreaterThan(0);
    expect(get.map((f) => f.params).filter((n) => n < 1)).toEqual([]);
    expect(set.map((f) => f.params).filter((n) => n < 2)).toEqual([]);
  });

  it('keeps no pointer to a most-recent run session', () => {
    const body = runLockBody();
    for (const banned of ['getSession', 'setSession', '_runLockSession']) {
      expect(body, `runLockControl reintroduced ${banned}`).not.toContain(banned);
    }
  });
});

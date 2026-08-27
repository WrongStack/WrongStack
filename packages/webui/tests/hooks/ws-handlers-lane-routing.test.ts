import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The routing boundary, enforced at the source level.
 *
 * A WS handler must address the session it is writing to. The moment one
 * reaches for the FOREGROUND facade instead — `useChatStore.getState()`,
 * `useSessionStore.getState().setIteration(...)` — a background run starts
 * writing into whichever tab happens to be on screen, and that is the entire
 * class of bug the lane registries exist to remove. It is invisible in review
 * (the line looks like every other store call) and only shows up when a second
 * tab is open, so it is pinned here instead.
 *
 * The escape hatches are named, not implied: `activeChatLane()` and
 * `activeSessionLane()` say "the tab in front, deliberately" and are what the
 * composer and the handful of legitimately untagged, fail-open events use.
 */

const handlerRoot = path.resolve(import.meta.dirname, '../../src/hooks');

function handlerFiles(): string[] {
  const files = [path.join(handlerRoot, 'ws-handlers.ts')];
  const dir = path.join(handlerRoot, 'ws-handlers');
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path.join(dir, entry.name));
  }
  return files;
}

/** Lane-scoped session state. Writing any of these through the foreground
 *  facade credits a background run to the wrong tab. */
const LANE_SCOPED_SESSION_WRITERS = [
  'setIteration',
  'setTodos',
  'setContextUsage',
  'setContextLimitWarning',
  'setCacheStats',
  'setDroppedTools',
  'updateUsage',
  'addCost',
  'startSession',
  'endSession',
];

function offendingLines(source: string, match: (line: string) => boolean): number[] {
  return source
    .split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*') && match(line))
    .map(({ n }) => n);
}

describe('WS handlers route by session, never to the tab in front', () => {
  const files = handlerFiles();

  it('finds the handler modules it is supposed to be guarding', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [path.basename(f), f] as const))(
    '%s does not touch the foreground chat facade',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      const offenders = offendingLines(source, (line) => line.includes('useChatStore'));
      expect(
        offenders,
        'use chatFor(msg) / chatLane(sessionId), or activeChatLane() when the foreground is genuinely meant',
      ).toEqual([]);
    },
  );

  it.each(files.map((f) => [path.basename(f), f] as const))(
    '%s does not write lane-scoped session state through the foreground facade',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      const offenders = offendingLines(source, (line) =>
        LANE_SCOPED_SESSION_WRITERS.some((writer) =>
          line.includes(`useSessionStore.getState().${writer}(`),
        ),
      );
      expect(
        offenders,
        'use sessionFor(msg) / sessionLane(sessionId), or activeSessionLane() when the foreground is genuinely meant',
      ).toEqual([]);
    },
  );

  it('routes every chat writer through the lane router', () => {
    // A handler module that writes chat state must import the router. This
    // catches a file that quietly grew a `chatLane('...')` literal or reached
    // into the registry by hand.
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const writesChat = /\bchat\.(addMessage|setMessages|appendToMessage|setLoading)\(/.test(
        source,
      );
      if (!writesChat) continue;
      expect(source, path.basename(file)).toMatch(/\bchatFor\b|\bactiveChatLane\b|\bchatLane\s*\(/);
    }
  });
});

/**
 * Stores that legitimately hold ONE copy for the whole page.
 *
 * Everything else in `src/stores` describes a session, so a handler writing
 * one without naming a session writes one tab's data into the copy all four
 * tabs read. Adding a store here is a claim that it is project-, server- or
 * browser-wide — check the server first: `goal`, `specs`, `sdd.board`,
 * `worktree` and `terminal` each have a SINGLE handler instance in
 * `backend-services.ts`, which is what makes their client stores global by
 * design rather than by omission.
 */
const PROJECT_WIDE_STORES = new Set([
  'useCodemapIndexStore',
  'useConfigStore',
  'useCronStore',
  'useFallbackStore',
  'useFileReferenceStore',
  'useFileStore',
  'useGitChangesStore',
  'useGitInfoStore',
  'useGoalAssessStore',
  'useGoalRunStore',
  'useGoalStateStore',
  'useGoalStore',
  'useHistoryStore',
  'useLocalPrefs',
  'useMailboxStore',
  'useMemoryInjectorStore',
  'useMemoryLifecycleStore',
  'useMonitorStore',
  'useOfficeMapStore',
  'useProviderStatusStore',
  'useSddBoardStore',
  'useSddWizardStore',
  'useSessionTabStore',
  'useSpecsStore',
  'useTechStackStore',
  'useUIStore',
  'useVizStore',
  'useWorktreeStore',
]);

/**
 * Stores whose every record carries its own `sessionId`, so one store object
 * still holds per-session data underneath.
 */
const SELF_KEYED_STORES = new Set([
  'useCodemapActivityStore',
  // The variant catalogue is one project fact, but WHICH variant is live is a
  // per-tab preference and is kept in `currentBySession`.
  'useSystemPromptStore',
  'useFleetStore',
  // `useSessionStore` is a facade over BOTH the project globals (cwd,
  // projectRoot, modes) and the foreground lane. A blanket ban here would
  // reject `handleWorkingDirChanged`, which correctly writes project globals.
  // The precise rule for it is the lane-scoped-writer check above, which names
  // the writers that must never go through the foreground.
  'useSessionStore',
]);

/** Anything that names a session — a positive router, or the legacy gate. */
const ROUTERS = [
  'chatFor(',
  'sessionFor(',
  'replyMeta(',
  'isActiveSessionMessage(',
  'messageSessionId(',
  'activeChatLane(',
  'activeSessionLane(',
  'chatLane(',
  'sessionLane(',
];

/** Extract the `{...}` body starting at the brace index `open`. */
function bodyAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i);
  }
  return source.slice(open);
}

/** `export function handleX(...) {` and `'some.type': (msg) => {` entries. */
function handlerBodies(source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re =
    /(?:export function (handle\w+)\s*\([^)]*\)[^{]*\{)|(?:^[ \t]*'?([\w.]+)'?:\s*(?:async\s*)?\((?:msg|_msg)[^)]*\)\s*(?::[^=]*)?=>\s*\{)/gm;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    out.push({ name: m[1] ?? m[2] ?? '?', body: bodyAt(source, m.index + m[0].length - 1) });
    m = re.exec(source);
  }
  return out;
}

describe('every handler that writes session state names the session', () => {
  /**
   * The audit that caught `coordinator-handlers.ts` writing twelve message
   * types straight into one global monitor store, pinned so the next store
   * wired to a handler cannot repeat it. A handler is compliant when it either
   * routes positively (`chatFor` / `sessionFor` / `sessionLane`) or gates on
   * `isActiveSessionMessage`. Anything else is one copy four tabs share.
   */
  it.each(handlerFiles().map((f) => [path.basename(f), f] as const))('%s', (_name, file) => {
    const source = readFileSync(file, 'utf8');
    // A module may gate its whole exported map in one wrapper instead of
    // repeating the check in every entry — stronger, because a handler added
    // later cannot forget it. The marker is what makes that visible here; it
    // is only honest if the wrapper really does gate every entry, so grep for
    // it when reviewing a new one.
    if (source.includes('/* lane-routing: gated-at-export */')) {
      expect(source).toMatch(/isActiveSessionMessage\(|sessionFor\(|chatFor\(/);
      return;
    }
    const offenders: string[] = [];
    for (const { name, body } of handlerBodies(source)) {
      if (ROUTERS.some((r) => body.includes(r))) continue;
      for (const store of new Set(
        [...body.matchAll(/\buse[A-Z]\w*(?:Store|Prefs)\b/g)].map((hit) => hit[0]),
      )) {
        if (PROJECT_WIDE_STORES.has(store) || SELF_KEYED_STORES.has(store)) continue;
        offenders.push(`${name} -> ${store}`);
      }
    }
    expect(
      offenders,
      'route with chatFor/sessionFor, gate with isActiveSessionMessage, or list the store in PROJECT_WIDE_STORES with a reason',
    ).toEqual([]);
  });
});

describe('the roster predicate is fail-closed', () => {
  it('no component re-invents the `!a.sessionId ||` allowance', () => {
    // An untagged agent listed in every tab at once is the roster half of the
    // cross-tab bleed. `agentBelongsToSession` is the single predicate; the
    // shape below is the one it replaced.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          if (/!\w+\.sessionId \|\|/.test(trimmed)) {
            offenders.push(`${path.basename(full)}: ${trimmed}`);
          }
        }
      }
    };
    walk(path.resolve(import.meta.dirname, '../../src/components'));
    expect(offenders, 'use agentBelongsToSession() from @/lib/agent-session').toEqual([]);
  });
});

/**
 * Which changed files this host's agents changed.
 *
 * Auto-review used to review every file that changed after a run started, and
 * at session end every changed file in the repository. In a working tree that
 * several sessions share, that put a peer session's work in progress (and the
 * tree's earlier uncommitted state) in front of this session's reviewer, whose
 * findings this agent was then asked to act on.
 *
 * A file is this host's when its modification time falls inside one of the
 * host's own tool calls (or a subagent's). That one rule covers every way the
 * agent writes: the file tools, and the shell (`sed -i`, a formatter, a code
 * generator), which leaves no per-file record. Peer sessions run in other
 * processes, so their tool calls never reach this bus. The window is the call
 * itself, not the whole iteration: a peer's edit while the model is thinking
 * falls outside it, though one made during a long-running command of this
 * session's still falls inside.
 *
 * A host that emits no tool events at all gets no filtering: every change is
 * reviewed, as before.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Plugin } from '@wrongstack/contracts/types/plugin';

type PluginApi = Parameters<NonNullable<Plugin['setup']>>[0];

/** File mtimes and event clocks are compared with this much leeway. */
const MTIME_SLACK_MS = 2000;
/** Closed windows kept; older ones merge into their neighbours first. */
const MAX_WINDOWS = 4000;

export interface ToolCallOwnership {
  /** True when a change at `mtimeMs` belongs to this host (or cannot be judged). */
  owns(mtimeMs: number | undefined): boolean;
  /** Stop listening. */
  dispose(): void;
}

export function trackToolCallOwnership(
  api: Pick<PluginApi, 'onEvent'>,
  now: () => number = Date.now,
): ToolCallOwnership {
  const open = new Map<string, number>();
  const closed: Array<[number, number]> = [];
  let seenToolCall = false;

  const start = (key: string): void => {
    seenToolCall = true;
    open.set(key, now());
  };
  const finish = (key: string): void => {
    const startedAt = open.get(key);
    if (startedAt === undefined) return;
    open.delete(key);
    const last = closed[closed.length - 1];
    // Overlapping or back-to-back calls collapse into one window. Ends only
    // grow (each is the finish time), which `owns` relies on; a parallel call
    // that started earlier widens the window's start.
    if (last && startedAt <= last[1] + MTIME_SLACK_MS) {
      last[0] = Math.min(last[0], startedAt);
      last[1] = Math.max(last[1], now());
    } else {
      closed.push([startedAt, now()]);
    }
    if (closed.length > MAX_WINDOWS) closed.splice(0, closed.length - MAX_WINDOWS);
  };

  const id = (event: unknown): string | undefined => {
    const value = (event as { id?: unknown } | undefined)?.id;
    return typeof value === 'string' && value ? value : undefined;
  };
  const subId = (event: unknown): string | undefined => {
    const callId = id(event);
    const agent = (event as { subagentId?: unknown } | undefined)?.subagentId;
    return callId ? `sub:${typeof agent === 'string' ? agent : ''}:${callId}` : undefined;
  };
  const offs: Array<() => void> = [];
  const on = (name: string, handler: (event: unknown) => void): void => {
    const off = (api.onEvent as (n: string, h: (event: unknown) => void) => unknown)(name, handler);
    if (typeof off === 'function') offs.push(off as () => void);
  };
  on('tool.started', (event) => {
    const key = id(event);
    if (key) start(key);
  });
  for (const name of ['tool.completed', 'tool.failed']) {
    on(name, (event) => {
      const key = id(event);
      if (key) finish(key);
    });
  }
  on('subagent.tool_started', (event) => {
    const key = subId(event);
    if (key) start(key);
  });
  on('subagent.tool_executed', (event) => {
    const key = subId(event);
    if (key) finish(key);
  });

  return {
    owns(mtimeMs) {
      if (!seenToolCall || mtimeMs === undefined || !Number.isFinite(mtimeMs)) return true;
      for (const startedAt of open.values()) {
        if (mtimeMs >= startedAt - MTIME_SLACK_MS) return true;
      }
      for (let i = closed.length - 1; i >= 0; i--) {
        const [from, to] = closed[i] as [number, number];
        if (mtimeMs > to + MTIME_SLACK_MS) return false;
        if (mtimeMs >= from - MTIME_SLACK_MS) return true;
      }
      return false;
    },
    dispose() {
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch {
          // The host may already have torn its bus down.
        }
      }
    },
  };
}

/** The `paths` (relative to `cwd`) whose current mtime `ownership` claims. */
export async function ownedPaths(
  cwd: string,
  paths: readonly string[],
  ownership: ToolCallOwnership,
): Promise<string[]> {
  const mtimes = await Promise.all(
    paths.map((p) =>
      fsp.stat(path.join(cwd, p)).then(
        (stat) => stat.mtimeMs,
        // Deleted or unreadable: nothing to date it by, so it is not filtered.
        () => undefined,
      ),
    ),
  );
  return paths.filter((_, i) => ownership.owns(mtimes[i]));
}

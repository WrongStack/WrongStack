import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DefaultSessionStore } from '../storage/session-store.js';
import type { SessionStore, SessionWriter } from '../types/session.js';
import { safeParse } from '../utils/safe-json.js';

export interface DirectorSubagentSessionSummary {
  lastAssistantText?: string | undefined;
  lastStopReason?: string | undefined;
  toolUsesObserved: number;
  events: number;
  path?: string | undefined;
}

/**
 * Per-subagent session factory.
 *
 * Director runs produce many parallel transcripts — one per spawned
 * subagent — and we want them all rooted under the same director-run
 * directory so a future `wstack replay <runId>` can rehydrate the whole
 * fleet from a single tree.
 *
 * The factory builds (or accepts) a `SessionStore` whose `dir` points at
 * `<sessionsRoot>/<directorRunId>/`, and returns a small `create()`
 * function that the orchestration layer calls per-spawn. Each call
 * yields a fresh `SessionWriter` whose JSONL file lives in that
 * directory, named by either the caller-supplied `subagentId` (preferred,
 * so the file name is human-readable) or a derived id.
 *
 * **Why a thin factory instead of plumbing options through every spawn
 * site?** Because the director is the only caller that needs this
 * isolation pattern, and shoving `sessionStore` options into
 * `SubagentConfig` would leak storage details into a config shape that
 * agents and the coordinator have no business knowing about.
 */
export interface DirectorSessionFactoryOptions {
  /**
   * Either a parent directory where `<directorRunId>/` will be created,
   * or a pre-built `SessionStore` whose `dir` already points at the
   * director run directory. Tests pass an in-memory store for isolation;
   * production code passes the path under `~/.wrongstack/sessions/`.
   */
  store?: SessionStore | undefined;
  sessionsRoot?: string | undefined;
  /**
   * Director run id — namespaces all subagent JSONLs under one folder.
   * Defaults to a timestamped id; supplied explicitly when resuming a
   * prior fleet manifest.
   */
  directorRunId?: string | undefined;
  /**
   * Session-level trace ID for correlating subagent storage events with
   * the parent session's trace in observability pipelines.
   */
  traceId?: string | undefined;
}

export interface DirectorSessionFactory {
  /** Absolute directory where this director run's transcripts live. */
  readonly dir: string;
  /** The director run id used to namespace the directory. */
  readonly directorRunId: string;
  /**
   * Create a fresh `SessionWriter` for the named subagent. Each
   * subagent gets its own JSONL file. The writer's `id` matches the
   * supplied `subagentId` so disk paths line up with in-memory ids.
   */
  createSubagentSession(args: {
    subagentId: string;
    provider?: string | undefined;
    model?: string | undefined;
    title?: string | undefined;
  }): Promise<SessionWriter>;
}

/**
 * Build a `DirectorSessionFactory`. Pass either a pre-configured
 * `SessionStore` (tests) or a `sessionsRoot` path (production). When
 * neither is supplied the factory throws — there's no sane default for
 * "where do these JSONLs live".
 */
export function makeDirectorSessionFactory(
  opts: DirectorSessionFactoryOptions,
): DirectorSessionFactory {
  const runId = opts.directorRunId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-director`;
  const { traceId } = opts;

  let store: SessionStore;
  let dir: string;
  if (opts.store) {
    // The caller wired its own store — we trust them on where the
    // files land. We can't introspect a `SessionStore`'s directory
    // without a typed accessor, so we report the run id and let the
    // caller record the path separately if needed.
    store = opts.store;
    dir = opts.sessionsRoot ? path.join(opts.sessionsRoot, runId) : '(caller-managed)';
  } else if (opts.sessionsRoot) {
    dir = path.join(opts.sessionsRoot, runId);
    store = new DefaultSessionStore({ dir });
  } else {
    throw new Error('makeDirectorSessionFactory requires either `store` or `sessionsRoot`');
  }

  return {
    dir,
    directorRunId: runId,
    async createSubagentSession({ subagentId, provider, model, title }) {
      // Per-subagent JSONL — DefaultSessionStore generates the file name
      // from the metadata `id`, so we pass `subagentId` directly to
      // keep disk artifacts human-readable.
      const writer = await store.create({
        id: subagentId,
        title: title ?? subagentId,
        provider: provider ?? 'unknown',
        model: model ?? 'unknown',
      });
      // Propagate the root trace ID so subagent storage events are
      // correlatable with the parent session in observability pipelines.
      if (traceId !== undefined) {
        writer.traceId = traceId;
      }
      return writer;
    },
  };
}

export async function readDirectorSubagentSession(args: {
  sessionsRoot: string | undefined;
  directorRunId: string;
  subagentId: string;
  tail?: number | undefined;
}): Promise<DirectorSubagentSessionSummary | null> {
  if (!args.sessionsRoot) return null;
  const filePath = path.join(args.sessionsRoot, args.directorRunId, `${args.subagentId}.jsonl`);
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const targetLines = args.tail ? lines.slice(-args.tail) : lines;
  let lastAssistantText: string | undefined;
  let lastStopReason: string | undefined;
  let toolUses = 0;
  for (const line of targetLines) {
    try {
      const parsed = safeParse<{
        type?: string | undefined;
        text?: string | undefined;
        stopReason?: string | undefined;
      }>(line);
      if (!parsed.ok || !parsed.value) continue;
      const ev = parsed.value;
      if (ev.type === 'assistant' && typeof ev.text === 'string') {
        lastAssistantText = ev.text;
      } else if (ev.type === 'stop' && ev.stopReason) {
        lastStopReason = ev.stopReason;
      } else if (ev.type === 'tool_use') {
        toolUses++;
      }
    } catch {
      // skip malformed lines
    }
  }
  return {
    lastAssistantText,
    lastStopReason,
    toolUsesObserved: toolUses,
    events: targetLines.length,
    path: filePath,
  };
}

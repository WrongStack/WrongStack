import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ResumeFileValidationEntry,
  ResumeValidation,
  SessionEvent,
} from '../types/session.js';
import { toErrorMessage } from '../utils/index.js';
import { mapWithConcurrency } from './storage-concurrency.js';

const MAX_REVALIDATE_BYTES = 5 * 1024 * 1024;
const VALIDATION_CONCURRENCY = 8;
const NOTICE_PATH_LIMIT = 20;

interface FileObservation {
  path: string;
  hash: string;
  ts: string;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function errno(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as NodeJS.ErrnoException).code)
    : undefined;
}

function latestObservations(events: readonly SessionEvent[], projectRoot: string): FileObservation[] {
  const latest = new Map<string, FileObservation>();
  for (const event of events) {
    if (
      event.type !== 'file_observation' ||
      typeof event.path !== 'string' ||
      event.path.length === 0 ||
      typeof event.hash !== 'string' ||
      !/^[a-f\d]{64}$/i.test(event.hash)
    ) {
      continue;
    }
    const normalized = path.resolve(projectRoot, event.path);
    latest.set(normalized, {
      path: normalized,
      hash: event.hash.toLowerCase(),
      ts: event.ts,
    });
  }
  return [...latest.values()];
}

async function validateOne(
  observation: FileObservation,
  lexicalRoot: string,
  realRoot: string,
): Promise<ResumeFileValidationEntry | null> {
  const base = {
    path: observation.path,
    observedAt: observation.ts,
    expectedHash: observation.hash,
  };

  if (!isInside(lexicalRoot, observation.path)) {
    return {
      ...base,
      status: 'outside_project',
      detail: 'Recorded path is outside the active project root.',
    };
  }

  let realFile: string;
  try {
    realFile = await fsp.realpath(observation.path);
  } catch (err) {
    if (errno(err) === 'ENOENT') return { ...base, status: 'deleted' };
    return { ...base, status: 'unreadable', detail: toErrorMessage(err) };
  }

  if (!isInside(realRoot, realFile)) {
    return {
      ...base,
      status: 'outside_project',
      detail: 'Recorded path resolves through a symlink outside the active project root.',
    };
  }

  try {
    const stat = await fsp.stat(realFile);
    if (!stat.isFile()) {
      return { ...base, status: 'unreadable', detail: 'Path is no longer a regular file.' };
    }
    if (stat.size > MAX_REVALIDATE_BYTES) {
      return {
        ...base,
        status: 'unreadable',
        detail: `File now exceeds the ${MAX_REVALIDATE_BYTES}-byte validation limit.`,
      };
    }
    // File tools persist sha256(UTF-8 text), so validation deliberately uses
    // the same decoding/hash semantics rather than hashing raw bytes.
    const content = await fsp.readFile(realFile, 'utf8');
    const actualHash = createHash('sha256').update(content, 'utf8').digest('hex');
    if (actualHash === observation.hash) return null;
    return { ...base, status: 'modified', actualHash };
  } catch (err) {
    if (errno(err) === 'ENOENT') return { ...base, status: 'deleted' };
    return { ...base, status: 'unreadable', detail: toErrorMessage(err) };
  }
}

/** Revalidate the latest persisted hash for every distinct observed path. */
export async function validateResumeFileObservations(
  events: readonly SessionEvent[],
  projectRoot: string,
): Promise<ResumeValidation> {
  const lexicalRoot = path.resolve(projectRoot);
  const realRoot = await fsp.realpath(lexicalRoot).catch(() => lexicalRoot);
  const observations = latestObservations(events, lexicalRoot);
  const results = await mapWithConcurrency(
    observations,
    VALIDATION_CONCURRENCY,
    (observation) => validateOne(observation, lexicalRoot, realRoot),
  );
  return {
    checkedAt: new Date().toISOString(),
    checkedFileCount: observations.length,
    staleFiles: results.filter((entry): entry is ResumeFileValidationEntry => entry !== null),
  };
}

/**
 * Headers of the system messages `resume()` injects.
 *
 * They are described as ephemeral, but every consumer hands the resumed
 * message list to `replaceMessages`, which journals it as a
 * `messages_replaced` snapshot — so a notice written on one resume is replayed
 * as ordinary conversation on the next one, and a fresh notice is added on top.
 * Three resumes with the same modified file left three copies, all but the last
 * describing a check that had already been superseded. `resume()` therefore
 * strips previous notices from the replayed conversation before appending the
 * current ones; these prefixes are how it recognizes them.
 */
export const RESUME_NOTICE_HEADERS = [
  '[SESSION RESUME FILE VALIDATION]',
  '[SESSION RESUME INTERRUPTED WORK]',
  '[SESSION RESUME CRASH RECOVERY]',
] as const;

/**
 * Build the ephemeral system message shown when the resumed session's newest
 * lifecycle boundary was a dangling `in_flight_start` — i.e. the previous
 * process died mid-iteration. Lists the interrupted tool calls that were
 * stripped from the restored conversation (adjacency repair) so the model
 * can decide whether to retry.
 * Returns null when the session did not crash.
 */
export function formatCrashRecoveryNotice(
  interruptedTools: ReadonlyArray<{ name: string; argsSummary?: string | undefined }>,
  lastContext: string | null,
): string | null {
  if (interruptedTools.length === 0) return null;
  const plural = interruptedTools.length === 1 ? 'call was' : 'calls were';
  const lines = [
    '[SESSION RESUME CRASH RECOVERY]',
    `The previous run stopped mid-iteration${
      lastContext ? ` while: ${lastContext}` : ''
    } — ${interruptedTools.length} tool ${plural} left without a recorded result.`,
    'Those interrupted tool calls were removed from the restored conversation and were NOT re-executed; their workspace side effects were NOT rolled back.',
  ];
  for (const tool of interruptedTools.slice(0, NOTICE_PATH_LIMIT)) {
    lines.push(`- ${tool.name}${tool.argsSummary ? ` (${tool.argsSummary})` : ''}`);
  }
  return lines.join('\n');
}

/**
 * True for a system message this module produced on an earlier resume.
 *
 * Deliberately narrow: only a `system` message whose text *starts* with one of
 * the headers matches, so a user or model quoting a notice back is never
 * mistaken for one.
 */
export function isResumeNoticeMessage(message: {
  role: string;
  content: unknown;
}): boolean {
  if (message.role !== 'system' || typeof message.content !== 'string') return false;
  return RESUME_NOTICE_HEADERS.some((header) => message.content === header || (message.content as string).startsWith(`${header}\n`));
}

/** Build the ephemeral system message injected into the first resumed turn. */
export function formatResumeValidationNotice(
  validation: ResumeValidation,
  projectRoot: string,
): string | null {
  if (validation.staleFiles.length === 0) return null;
  const root = path.resolve(projectRoot);
  const shown = validation.staleFiles.slice(0, NOTICE_PATH_LIMIT).map((entry) => {
    const relative = path.relative(root, entry.path);
    const display = isInside(root, entry.path) ? relative || '.' : entry.path;
    return `- ${JSON.stringify(display)} [${entry.status}]`;
  });
  const omitted = validation.staleFiles.length - shown.length;
  if (omitted > 0) shown.push(`- ... and ${omitted} more stale path(s)`);

  return [
    '[SESSION RESUME FILE VALIDATION]',
    `Journal hash validation found ${validation.staleFiles.length} previously observed file(s) whose current state cannot be trusted.`,
    'Prior tool results and reasoning based on these paths are stale. Re-read each relevant file before relying on it or editing it.',
    ...shown,
  ].join('\n');
}

/**
 * Build the ephemeral system message injected when the resumed session had
 * tool calls still in flight (the previous run crashed or was interrupted
 * before their results were recorded). The interrupted `tool_use` blocks are
 * stripped from the reconstructed conversation by adjacency repair and are NOT
 * re-executed on resume — this notice simply makes the interruption visible so
 * the model can decide whether to retry the work. Returns null when nothing
 * was in flight.
 */
export function formatInterruptedToolNotice(pendingToolUseCount: number): string | null {
  if (!Number.isFinite(pendingToolUseCount) || pendingToolUseCount <= 0) return null;
  const plural = pendingToolUseCount === 1 ? 'tool call was' : 'tool calls were';
  return [
    '[SESSION RESUME INTERRUPTED WORK]',
    `The previous run left ${pendingToolUseCount} ${plural} in flight — no result was recorded before it stopped (crash or interrupt).`,
    'Those interrupted tool calls were removed from the restored conversation and were NOT re-executed. Re-run the work if it still needs doing.',
  ].join('\n');
}

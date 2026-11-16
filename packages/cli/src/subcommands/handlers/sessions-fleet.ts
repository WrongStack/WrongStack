import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { color } from '@wrongstack/core/utils';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';

/**
 * `wrongstack sessions fleet [runId]`
 *
 * Lists fleet run artifacts under `projectSessions/<runId>/`.
 * When runId is omitted, lists all fleet runs discovered under projectSessions.
 *
 * Artifacts shown:
 *   - fleet.json         (manifest)
 *   - checkpoint.json    (state snapshot, if present)
 *   - shared/            (scratchpad directory)
 *   - subagents/         (per-subagent JSONL transcripts)
 */
/**
 * Files the run store maintains that are not subagent transcripts: the
 * store-level `_index.jsonl` (written into every director run directory on
 * create) and per-session sidecars (`.replay.jsonl`, `.audit.jsonl`, legacy
 * `.annotations.jsonl`). Mirrors core's `isSessionTranscriptFileName` — it is
 * not exported from `@wrongstack/core/utils`.
 */
const STORE_SIDECAR_JSONL_NAMES = new Set(['_index.jsonl', '_mailbox.jsonl']);
const SESSION_SIDECAR_JSONL_SUFFIXES = ['.replay.jsonl', '.audit.jsonl', '.annotations.jsonl'];

function isSubagentTranscriptFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.jsonl')) return false;
  if (STORE_SIDECAR_JSONL_NAMES.has(lower)) return false;
  return !SESSION_SIDECAR_JSONL_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Subagent transcript names under a fleet run's `subagents/` directory.
 *
 * The director session factory roots a DefaultSessionStore at
 * `subagents/<directorRunId>/`, so journals live ONE level deeper than the
 * flat `subagents/<subagentId>.jsonl` layout this command was written
 * against — both are collected. Reserved subdirectories are skipped:
 * `transcripts` holds the agent-monitor's copies (at
 * `transcripts/<id>/transcript.jsonl`) and `shared` is the scratchpad.
 */
async function collectSubagentTranscripts(subagentsDir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      if (isSubagentTranscriptFile(entry.name)) out.push(entry.name);
      continue;
    }
    if (!entry.isDirectory() || entry.name === 'transcripts' || entry.name === 'shared') continue;
    let nested: string[];
    try {
      nested = await fsp.readdir(path.join(subagentsDir, entry.name));
    } catch {
      continue;
    }
    for (const name of nested) {
      if (isSubagentTranscriptFile(name)) out.push(`${entry.name}/${name}`);
    }
  }
  return out;
}

export const sessionsFleetCmd: SubcommandHandler = async (args, deps) => {
  const runId = args.find((a) => !a.startsWith('-'));

  if (runId) {
    return showFleetRun(runId, deps);
  }
  return listFleetRuns(deps);
};

/** A directory counts as a fleet run when any fleet artifact sits at its root. */
async function hasFleetRunArtifacts(dir: string): Promise<boolean> {
  const markers = await Promise.all(
    (['fleet.json', 'checkpoint.json', 'subagents'] as const).map((name) =>
      fsp.access(path.join(dir, name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return markers.some((found) => found);
}

/**
 * Fleet-run ids under projectSessions.
 *
 * Fleet roots are `sessionScopedPath(projectSessions, session.id, '')` and
 * modern session ids are date-sharded, so a real run lives at
 * `<projectSessions>/<shard>/<sessionId>/` — two levels deep. A directory
 * with fleet artifacts at its own root is a (legacy, flat) run; otherwise it
 * is a container (a date shard) and its marker-bearing children are the
 * runs. Containers with no run children are not runs and are not listed.
 */
async function discoverFleetRunIds(projectSessions: string): Promise<string[]> {
  const entries = await fsp.readdir(projectSessions, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectSessions, entry.name);
    if (await hasFleetRunArtifacts(dir)) {
      ids.push(entry.name);
      continue;
    }
    let children: import('node:fs').Dirent[];
    try {
      children = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (await hasFleetRunArtifacts(path.join(dir, child.name))) {
        ids.push(`${entry.name}/${child.name}`);
      }
    }
  }
  return ids;
}

async function listFleetRuns(deps: SubcommandDeps): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await discoverFleetRunIds(deps.paths.projectSessions);
  } catch {
    deps.renderer.writeError(`Cannot read projectSessions: ${deps.paths.projectSessions}\n`);
    return 1;
  }

  const runs: Array<{ id: string; manifest: boolean; checkpoint: boolean; subagents: number }> = [];

  // Per-entry inspection can run in parallel — each entry's stat +
  // access(manifest) + access(checkpoint) + readdir(subagents) are all
  // independent files. The Promise.all below runs all four concurrently
  // per entry, then derives the boolean fields from the resolved
  // outcomes. Outer parallelism (Promise.all over entries) is bounded
  // by the number of entries, which is the number of session runs on
  // disk — small enough that unbounded fan-out is safe.
  const perEntry = await Promise.all(
    entries.map(
      async (
        id,
      ): Promise<{
        id: string;
        manifest: boolean;
        checkpoint: boolean;
        subagents: number;
      } | null> => {
        const runDir = path.join(deps.paths.projectSessions, id);
        try {
          const stat = await fsp.stat(runDir);
          if (!stat.isDirectory()) return null;
        } catch {
          return null; // skip inaccessible entries
        }
        const [manifestResult, checkpointResult, subagentFilesResult] = await Promise.all([
          fsp.access(path.join(runDir, 'fleet.json')).then(
            () => true,
            () => false,
          ),
          fsp.access(path.join(runDir, 'checkpoint.json')).then(
            () => true,
            () => false,
          ),
          collectSubagentTranscripts(path.join(runDir, 'subagents')).then(
            (files) => files.length,
            () => 0,
          ),
        ]);
        return {
          id,
          manifest: manifestResult,
          checkpoint: checkpointResult,
          subagents: subagentFilesResult,
        };
      },
    ),
  );
  for (const r of perEntry) if (r) runs.push(r);

  if (runs.length === 0) {
    deps.renderer.write('No fleet runs found.\n');
    return 0;
  }

  deps.renderer.write(color.bold('\nFleet Runs\n') + '\n');
  for (const r of runs.sort((a, b) => b.id.localeCompare(a.id))) {
    const checkpointFlag = r.checkpoint ? color.green('✓') : color.dim('○');
    const manifestFlag = r.manifest ? color.green('✓') : color.dim('○');
    const subagentInfo = r.subagents > 0 ? color.dim(`  ${r.subagents} subagent jsonl`) : '';
    deps.renderer.write(
      `  ${color.bold(r.id)}  ${checkpointFlag} checkpoint  ${manifestFlag} manifest${subagentInfo}\n`,
    );
  }
  deps.renderer.write(`\n  ${color.dim('Run `wrongstack sessions fleet <runId>` for details.')}\n`);
  return 0;
}

async function showFleetRun(runId: string, deps: SubcommandDeps): Promise<number> {
  const runDir = path.join(deps.paths.projectSessions, runId);

  let stat;
  try {
    stat = await fsp.stat(runDir);
  } catch {
    deps.renderer.writeError(`Fleet run not found: ${runId}\n`);
    return 1;
  }

  if (!stat.isDirectory()) {
    deps.renderer.writeError(`Not a directory: ${runId}\n`);
    return 1;
  }

  deps.renderer.write(color.bold(`\nFleet Run: ${runId}\n`) + '\n');

  // Manifest
  const manifestPath = path.join(runDir, 'fleet.json');
  let manifestData: string | null = null;
  try {
    manifestData = (await fsp.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, '');
    const manifest = JSON.parse(manifestData);
    if (!manifest || typeof manifest !== 'object') throw new Error('Invalid fleet manifest');
    const subagents = manifest.subagents ?? [];
    const tasks = manifest.tasks ?? [];
    const completed = tasks.filter(
      (t: { status?: string | undefined }) =>
        t.status === 'completed' ||
        t.status === 'failed' ||
        t.status === 'timeout' ||
        t.status === 'stopped',
    );
    deps.renderer.write(
      `  ${color.green('✓')} fleet.json — ${subagents.length} subagent(s), ${completed.length}/${tasks.length} tasks done\n`,
    );
  } catch {
    deps.renderer.write(`  ${color.dim('○')} fleet.json — not found\n`);
  }

  // Checkpoint
  const checkpointPath = path.join(runDir, 'checkpoint.json');
  let checkpointData: string | null = null;
  try {
    checkpointData = (await fsp.readFile(checkpointPath, 'utf8')).replace(/^\uFEFF/, '');
    const snap = JSON.parse(checkpointData);
    if (!snap || typeof snap !== 'object') throw new Error('Invalid checkpoint');
    const lockPath = `${checkpointPath}.lock`;
    let lockStatus = color.dim('○ no lock');
    try {
      const lockRaw = (await fsp.readFile(lockPath, 'utf8')).replace(/^\uFEFF/, '');
      const lock = JSON.parse(lockRaw);
      if (!lock || typeof lock !== 'object') throw new Error('Invalid lock');
      lockStatus = `${color.yellow('▸')} lock held by pid ${lock.pid} on ${lock.hostname} (started ${lock.startedAt})`;
    } catch {
      lockStatus = color.green('✓ no lock (safe to resume)');
    }
    deps.renderer.write(
      `  ${color.green('✓')} checkpoint.json — updated ${snap.updatedAt}, ${snap.spawnCount} spawns, ${snap.tasks?.length ?? 0} tasks tracked\n    ${lockStatus}\n`,
    );
  } catch {
    deps.renderer.write(`  ${color.dim('○')} checkpoint.json — not found\n`);
  }

  // State snapshot
  if (checkpointData) {
    try {
      const snap = JSON.parse(checkpointData);
      if (snap.subagents?.length) {
        deps.renderer.write('\n  Subagents:\n');
        for (const s of snap.subagents) {
          deps.renderer.write(
            `    ${color.cyan(s.id)}  ${s.name ? `${s.name} ` : ''}${s.provider ? `(${s.provider}/${s.model})` : ''}  spawned ${s.spawnedAt}\n`,
          );
        }
      }
      if (snap.tasks?.length) {
        deps.renderer.write('\n  Tasks:\n');
        for (const t of snap.tasks) {
          deps.renderer.write(
            `    ${color.dim(t.taskId)}  ${t.status}  ${t.description ? t.description.slice(0, 50) : '(no description)'}\n`,
          );
        }
      }
    } catch {
      // skip parse errors
    }
  }

  // Subagents directory
  const subagentsDir = path.join(runDir, 'subagents');
  let subagentFiles: string[] = [];
  try {
    subagentFiles = await collectSubagentTranscripts(subagentsDir);
  } catch {
    // no subagents dir
  }

  if (subagentFiles.length > 0) {
    deps.renderer.write(`\n  Subagent transcripts (${subagentFiles.length}):\n`);
    // Stat all transcript files in parallel — each is an independent read,
    // bounded by the number of subagents in this run (typically <100).
    const sortedFiles = subagentFiles.sort();
    const sizes = await Promise.all(
      sortedFiles.map(async (f) => {
        const filePath = path.join(subagentsDir, f);
        try {
          const s = await fsp.stat(filePath);
          return s.size;
        } catch {
          return 0;
        }
      }),
    );
    for (let i = 0; i < sortedFiles.length; i++) {
      const size = sizes[i] ?? 0;
      const sizeStr =
        size > 1024 * 1024
          ? `${(size / 1024 / 1024).toFixed(1)}MB`
          : `${(size / 1024).toFixed(0)}KB`;
      deps.renderer.write(`    ${color.dim(sortedFiles[i] ?? '')}  ${color.dim(sizeStr)}\n`);
    }
  } else {
    deps.renderer.write(`\n  ${color.dim('○')} No subagent transcripts\n`);
  }

  // Shared directory
  const sharedDir = path.join(runDir, 'shared');
  try {
    const files = await fsp.readdir(sharedDir);
    deps.renderer.write(`\n  Shared scratchpad: ${files.length} file(s)\n`);
  } catch {
    deps.renderer.write(`\n  ${color.dim('○')} No shared scratchpad\n`);
  }

  deps.renderer.write(`\n  ${color.dim('Resume: wrongstack --resume ' + runId)}\n`);
  return 0;
}

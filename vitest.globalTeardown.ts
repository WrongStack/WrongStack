/**
 * Reap project-server daemons a test run left behind.
 *
 * Daemons are spawned `detached` + `unref()`ed, so nothing in the test process
 * owns them. When a suite forgets the kill switch (or a daemon's own idle exit
 * is broken), they survive the run: four ~45MB kanban daemons were found alive
 * on a dev machine, still bound to `wstack-tools-smoke-*` / `wiring-session-*`
 * temp directories that had been deleted hours earlier.
 *
 * Scope is deliberately narrow — only processes whose `--project-root` (or
 * `--project-dir`) lies under the OS temp directory are touched. Those can only
 * have come from a test; a daemon serving a real project is never a candidate.
 */
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

interface Candidate {
  pid: number;
  commandLine: string;
}

const ROOT_FLAG = /--project-(?:root|dir)[\s=]+("[^"]+"|\S+)/u;

function isTempRooted(commandLine: string): boolean {
  if (!commandLine.includes('project-server')) return false;
  const match = ROOT_FLAG.exec(commandLine);
  if (!match?.[1]) return false;
  const root = path.resolve(match[1].replace(/^"|"$/gu, ''));
  const tmp = path.resolve(os.tmpdir());
  const rel = path.relative(tmp, root);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function listNodeProcesses(): Promise<Candidate[]> {
  if (process.platform === 'win32') {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const raw = stdout.trim();
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((r) => r as { ProcessId?: number; CommandLine?: string | null })
      .filter((r) => typeof r.ProcessId === 'number' && typeof r.CommandLine === 'string')
      .map((r) => ({ pid: r.ProcessId as number, commandLine: r.CommandLine as string }));
  }
  const { stdout } = await run('ps', ['-eo', 'pid=,args='], { maxBuffer: 16 * 1024 * 1024 });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const spaceAt = line.indexOf(' ');
      return { pid: Number(line.slice(0, spaceAt)), commandLine: line.slice(spaceAt + 1) };
    })
    .filter((c) => Number.isFinite(c.pid));
}

/**
 * Vitest runs the default export at setup. Returning the teardown function is
 * the contract every Vitest version supports; the named `teardown` export below
 * is kept as well so either resolution path works.
 */
export default function setup(): () => Promise<void> {
  return teardown;
}

/** Runs once, after the whole test run. */
export async function teardown(): Promise<void> {
  let candidates: Candidate[];
  try {
    candidates = await listNodeProcesses();
  } catch {
    // Process enumeration is best-effort; never fail a green run over it.
    return;
  }

  const orphans = candidates.filter((c) => c.pid !== process.pid && isTempRooted(c.commandLine));
  if (orphans.length === 0) return;

  for (const orphan of orphans) {
    try {
      process.kill(orphan.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[vitest] reaped ${orphans.length} temp-rooted project-server daemon(s) left by this run:\n` +
      orphans.map((o) => `  pid ${o.pid}: ${o.commandLine.slice(0, 160)}`).join('\n'),
  );
}

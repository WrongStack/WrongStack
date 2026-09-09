/**
 * A daemon that dies must leave a reason behind.
 *
 * The detached codebase-index daemon was spawned with `stdio: 'ignore'`. When
 * it went away mid-request the client rejected every in-flight call with
 * `codebase-index server connection closed` — the symptom, and nothing about
 * the cause. Under a loaded full-suite run that is exactly the failure that
 * appeared, and there was no evidence anywhere on disk or in the logs to
 * explain it: not a stack trace, not an exit code, nothing.
 *
 * Keeping stderr is what makes the difference, and it is deliberately the
 * STREAM rather than an in-process handler: Node writes an uncaught
 * exception's stack there before exiting, and V8 writes its fatal
 * out-of-memory message there too — the one no `uncaughtException` handler
 * can ever intercept, and a plausible cause of a daemon dying under memory
 * pressure.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatProjectIndexServerCloseError,
  PROJECT_INDEX_SERVER_CLOSED_MESSAGE,
  PROJECT_INDEX_SERVER_STDERR_MAX_BYTES,
  projectIndexServerStderrPath,
  readProjectIndexServerStderrTail,
} from '../src/codebase-index/project-server-endpoint.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-stderr-'));
  roots.push(root);
  return root;
}

describe('daemon stderr diagnosis', () => {
  it('puts the log beside the index rather than in a shared temp dir', () => {
    const root = tempRoot();
    const logPath = projectIndexServerStderrPath(root, path.join(root, '.index'));
    // Per project: two projects crashing must not interleave into one file,
    // and removing a project's index removes its log with it.
    expect(path.dirname(logPath)).toBe(path.resolve(root, '.index'));
  });

  it('reads back the reason a dead daemon printed', () => {
    const root = tempRoot();
    const logPath = projectIndexServerStderrPath(root, path.join(root, '.index'));
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      [
        '',
        'file:///D:/x/project-server.js:41',
        "        throw new Error('index store is corrupt');",
        '        ^',
        'Error: index store is corrupt',
        '    at consume (project-server.js:41:15)',
      ].join('\n'),
    );
    const tail = readProjectIndexServerStderrTail(logPath);
    expect(tail).toContain('index store is corrupt');
    // Condensed to one line: this is appended to an Error message, and a
    // multi-line message is unreadable in a test report or a status line.
    expect(tail).not.toContain('\n');
  });

  it('reports nothing when the daemon exited cleanly', () => {
    // A clean shutdown writes no stderr, and an orderly close must not be
    // dressed up as a crash. Absent, empty, and whitespace-only all mean
    // "no evidence", not "here is a blank reason".
    const root = tempRoot();
    const logPath = projectIndexServerStderrPath(root, path.join(root, '.index'));
    expect(readProjectIndexServerStderrTail(logPath)).toBeNull();

    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '');
    expect(readProjectIndexServerStderrTail(logPath)).toBeNull();

    fs.writeFileSync(logPath, '\n  \n\t\n');
    expect(readProjectIndexServerStderrTail(logPath)).toBeNull();
  });

  it('keeps the newest lines, not the oldest, and bounds what it reads', () => {
    // A crash-looping daemon writes the same trace repeatedly. The useful
    // part is the most recent death, and the read must stay bounded so a
    // large log is never pulled into memory whole.
    const root = tempRoot();
    const logPath = projectIndexServerStderrPath(root, path.join(root, '.index'));
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const filler = `${'x'.repeat(200)}\n`.repeat(2000);
    fs.writeFileSync(logPath, `${filler}Error: the death that matters\n`);
    expect(fs.statSync(logPath).size).toBeGreaterThan(PROJECT_INDEX_SERVER_STDERR_MAX_BYTES);

    const tail = readProjectIndexServerStderrTail(logPath, 1);
    expect(tail).toBe('Error: the death that matters');
  });

  it('survives a log it cannot read instead of masking the close', () => {
    // Diagnosis is a bonus on top of the real error. If reading the log
    // throws for any reason, the caller must still get its close error —
    // never an exception from the diagnostic path itself.
    const root = tempRoot();
    expect(readProjectIndexServerStderrTail(path.join(root, 'no', 'such', 'file'))).toBeNull();
    // A directory where a file is expected: statSync succeeds, the read does not.
    const asDir = path.join(root, 'a-directory');
    fs.mkdirSync(asDir);
    expect(() => readProjectIndexServerStderrTail(asDir)).not.toThrow();
  });

  it('keeps the old message as a prefix so nothing matching on it breaks', () => {
    // Log searches and any caller matching the message as a substring must
    // keep working; the reason is added, never substituted.
    const withReason = formatProjectIndexServerCloseError('Error: heap out of memory');
    expect(withReason.startsWith(PROJECT_INDEX_SERVER_CLOSED_MESSAGE)).toBe(true);
    expect(withReason).toContain('heap out of memory');
    expect(formatProjectIndexServerCloseError(null)).toBe(PROJECT_INDEX_SERVER_CLOSED_MESSAGE);
  });
});

/**
 * WS-059 — two lifecycle races that corrupt the one-daemon-per-project
 * invariant, both duplicated across every project daemon.
 *
 * 1. `writeMetadata` did a hand-rolled write + rename with an
 *    `rm(metadataPath)` fallback. On Windows `rename` fails whenever a reader
 *    holds the destination, so the rm branch was not an edge case — it was the
 *    common path. Between the `rm` and the retry `rename` the metadata file
 *    does not exist, and a client that reads it in that window concludes there
 *    is no daemon and spawns a second one.
 *
 * 2. `stop()` released the endpoint (`server.close()`) BEFORE removing
 *    metadata, and `removeOwnedMetadata` is a read-pid-then-delete. A
 *    successor daemon could bind, write its metadata, and have it deleted by
 *    the departing process — leaving a live daemon no client could find.
 *
 * The second fix is ordering rather than a tighter check, because a pid
 * comparison cannot be made atomic on a filesystem. Removing metadata while
 * the endpoint is still held means no successor can exist yet: the bind IS the
 * ownership election, which the startup path already documents. Shutdown is
 * now its mirror.
 *
 * This is a source-shape ratchet. The races are timing-dependent across
 * processes and platforms — a behavioural test would be slow and flaky, and
 * would not run the Windows branch on CI's Linux runners at all. What is
 * checkable everywhere is that no daemon has drifted back to the unlink-first
 * write or the release-endpoint-first shutdown.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');

/** Every per-project daemon that owns an endpoint + metadata file. */
const DAEMONS = [
  'packages/core/src/coordination/mailbox-project-server.ts',
  'packages/core/src/chronicle/project-server.ts',
  'packages/sage/src/project-server.ts',
] as const;

function source(relative: string): string {
  return readFileSync(resolve(repoRoot, relative), 'utf8');
}

/** Strip whole-line comments so prose about the fix is not mistaken for it. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('Chronicle shutdown acknowledgement', () => {
  const body = code(source('packages/core/src/chronicle/project-server.ts'));

  it('flushes the shutdown response before stopping the server', () => {
    expect(body).toMatch(
      /if \(message\.type === 'shutdown'\) \{\s*await sendAcknowledgement\(state,/,
    );
    expect(body).toMatch(/state\.socket\.write\(encoded, \(error\) => \{/);
  });

  it('resolves stop only from the server close acknowledgement', () => {
    const stopStart = body.indexOf('async function stop');
    const stopEnd = body.indexOf('server.on(', stopStart);
    const stopBody = body.slice(stopStart, stopEnd);

    expect(stopBody).toMatch(/server\.close\(\(error\) => \{/);
    expect(stopBody).not.toMatch(/setTimeout\(/);
  });
});

describe.each(DAEMONS)('%s', (file) => {
  it('writes metadata atomically, never unlink-then-rename', () => {
    const body = code(source(file));
    // The exact shape that leaves the file absent mid-write.
    expect(body).not.toMatch(
      /rm\(metadataPath,\s*\{\s*force:\s*true\s*\}\);\s*\n\s*await\s+\w+\.rename\(/,
    );
    expect(body).toMatch(/atomicWrite\(metadataPath/);
  });

  it('keeps the owner-only file mode on the metadata write', () => {
    // The token lives only in this file (WS-027/WS-028); atomicWrite must not
    // be adopted at the cost of dropping the mode.
    expect(code(source(file))).toMatch(/mode:\s*0o600/);
  });

  it('removes its metadata BEFORE releasing the endpoint', () => {
    const body = code(source(file));
    const remove = body.indexOf('await removeOwnedMetadata()');
    const close = body.indexOf('server.close(');
    expect(remove, 'stop() must call removeOwnedMetadata').toBeGreaterThan(-1);
    expect(close, 'stop() must close the server').toBeGreaterThan(-1);
    expect(remove).toBeLessThan(close);
  });

  it('removes its metadata exactly once', () => {
    // The reorder is a move, not an addition — a leftover second call would
    // run after the endpoint is free and reintroduce the race it fixes.
    const body = code(source(file));
    const calls = body.match(/await removeOwnedMetadata\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('still guards the delete with a pid comparison', () => {
    // Ordering closes the successor race; the pid check remains the backstop
    // for a stale file left by a previously crashed process.
    expect(code(source(file))).toMatch(/current\.pid === process\.pid/);
  });
});

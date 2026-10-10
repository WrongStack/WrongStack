/**
 * HqSimpleLog line-count recovery after a failed count.
 *
 * `ensureLineCount` establishes how many lines the append-only log already has,
 * so the rotation decision (`lineCount < maxLines`) and the tail-read estimate
 * are anchored to reality. `countNonEmptyLines` RESOLVES 0 for a missing file —
 * a correct answer — but REJECTS when a read faults part way through.
 *
 * That rejection used to be caught into `.catch(() => 0)` and then latched as
 * `counted = true`: the store believed the log was empty for the rest of the
 * process, counted only fresh appends from zero, and so did not rotate until it
 * had accumulated a full `maxLines` of new records. One transient read fault
 * (EIO, an AV scanner, a flaky network home) silently stretched the on-disk log
 * well past its cap, with no error anywhere to explain it.
 *
 * The fix mirrors `HqEventLog.ensureLineCount`: on a failed count the memo is
 * dropped and the store stays uncounted, so the next append retries a healed
 * file. `append` is best-effort and must never reject, so the fault is absorbed
 * here rather than propagated.
 *
 * Only the fs READ is injected; the log, the count, the lock and the atomic
 * write all run as real production code.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LOG = 'recovery.jsonl';

const readFault = vi.hoisted(() => ({ armed: false, reads: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = actual.open;
  return {
    ...actual,
    open: async (p: Parameters<typeof open>[0], flags?: string, mode?: number) => {
      const handle = await open(p as string, flags as never, mode);
      if (!(String(p).endsWith(LOG) && flags === 'r')) return handle;
      return new Proxy(handle, {
        get(target, prop) {
          if (prop !== 'read') {
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (...args: unknown[]) => {
            readFault.reads += 1;
            // Armed means every read of the log fails — a fault that has not
            // healed. Counts and tail reads both go through here.
            if (readFault.armed) {
              const err: NodeJS.ErrnoException = new Error('EIO: simulated read fault');
              err.code = 'EIO';
              throw err;
            }
            return (target.read as (...a: unknown[]) => unknown)(...args);
          };
        },
      });
    },
  };
});

import { HqSimpleLog } from '../../src/hq/persistence.js';

interface Row {
  n: number;
}

let dataDir: string;
const filePath = () => path.join(dataDir, LOG);

function makeLog(maxLines: number): HqSimpleLog<Row> {
  return new HqSimpleLog<Row>({
    dataDir,
    filename: LOG,
    maxLines,
    rotateKeep: Math.floor(maxLines / 2),
    readLimit: 100,
  });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-simple-log-count-'));
  readFault.armed = false;
  readFault.reads = 0;
});

afterEach(async () => {
  readFault.armed = false;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('HqSimpleLog line-count recovery', () => {
  it('retries the count on the next append after a failed one', async () => {
    // A log that already has some history, so a real (non-zero) count exists.
    await fs.writeFile(
      filePath(),
      `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n${JSON.stringify({ n: 3 })}\n`,
    );
    const log = makeLog(1000);

    // First append: the count read faults. `append` is best-effort and must not
    // reject, so the record is still written; only the count is left unknown.
    readFault.armed = true;
    log.append({ n: 4 });
    await log.drain();
    expect(readFault.reads).toBeGreaterThan(0);

    // Fault clears. The store must NOT be latched as "counted" — the next append
    // has to go back to disk for the real count.
    readFault.armed = false;
    readFault.reads = 0;
    log.append({ n: 5 });
    await log.drain();

    // A latched zero would short-circuit here and read nothing; recovery means
    // this append re-counts the file it now has to base rotation on.
    expect(readFault.reads).toBeGreaterThan(0);
  });

  it('rotates against the real line count after a recovered failure', async () => {
    // The consequence of the latch: with `lineCount` stuck at 0 the log only
    // rotates after a full `maxLines` of fresh appends, over-running its cap.
    // Here the file starts at 3 lines and `maxLines` is 5, so the correct count
    // puts the store 2 appends from rotation; a latched zero would need 5.
    await fs.writeFile(
      filePath(),
      `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n${JSON.stringify({ n: 3 })}\n`,
    );
    const log = makeLog(5);

    // Fault the very first count, then heal.
    readFault.armed = true;
    log.append({ n: 4 });
    await log.drain();
    readFault.armed = false;

    // Appends 5 and 6: the recovered count is 5 (3 on disk + n:4), so the next
    // append crosses `maxLines` and rotation trims the tail to `rotateKeep`.
    log.append({ n: 5 });
    await log.drain();
    log.append({ n: 6 });
    await log.drain();

    const raw = await fs.readFile(filePath(), 'utf8');
    const rows = raw.split('\n').filter((l) => l.length > 0);
    // Rotation ran and trimmed to the retained window, proving the store used a
    // real line count rather than the latched zero.
    expect(rows.length).toBeLessThanOrEqual(3);
    const kept = rows.map((l) => (JSON.parse(l) as Row).n);
    expect(kept).toContain(6);
  });
});

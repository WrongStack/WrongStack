import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HqEventLog } from '../src/persistence/event-log.js';

// `recent()` with a filter scans the newest 256 KiB in 64 KiB chunks, then
// reads the rest of the file in 8 MiB windows, newest first.
const TAIL_SCAN_BYTES = 4 * 64 * 1024;
const WINDOW_BYTES = 8 * 1024 * 1024;

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-eventlog-seam-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/**
 * Write an `events.jsonl` whose oldest line holds `run`, laid out so the 8 MiB
 * window boundary falls `skew` bytes into that run.
 */
async function writeLog(run: string, skew: number): Promise<void> {
  const target = JSON.stringify({ type: 'target', payload: { s: run } });
  const runStart = Buffer.byteLength(target.slice(0, target.indexOf(run[0]!)), 'utf8');
  const size = runStart + skew + TAIL_SCAN_BYTES + WINDOW_BYTES;
  const parts = [target, '\n'];
  let remaining = size - Buffer.byteLength(target, 'utf8') - 1;
  const base = JSON.stringify({ type: 'filler', payload: { p: '' } }).length + 1;
  while (remaining > 0) {
    const lineLength = remaining > 2000 ? 1000 : remaining;
    const line = JSON.stringify({ type: 'filler', payload: { p: 'x'.repeat(lineLength - base) } });
    parts.push(line, '\n');
    remaining -= line.length + 1;
  }
  const bytes = Buffer.from(parts.join(''), 'utf8');
  expect(bytes.length).toBe(size);
  await fs.writeFile(path.join(dataDir, 'events.jsonl'), bytes);
}

describe('HqEventLog.recent bulk window seam', () => {
  it('keeps a multibyte character split by the 8 MiB window boundary intact', async () => {
    const run = 'é'.repeat(4000);
    // Odd skew: the boundary lands between the two bytes of one `é`.
    await writeLog(run, 1001);
    const events = await new HqEventLog({ dataDir }).recent(1, 'target');
    expect(events).toHaveLength(1);
    const s = (events[0]?.payload as { s?: string } | undefined)?.s ?? '';
    // Compact assertions: a corrupted seam shows up as U+FFFD and a length drift.
    expect(s.includes('\uFFFD')).toBe(false);
    expect(s.length).toBe(run.length);
    expect(s === run).toBe(true);
  });
});

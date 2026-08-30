import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionDataFromFile } from '../../src/storage/session-store/load-session-data.js';
import type { SecretScrubber } from '../../src/types/secret-scrubber.js';

const passthroughScrubber: SecretScrubber = {
  scrub: (text) => text,
  scrubObject: (obj) => obj,
};

describe('loadSessionDataFromFile — load progress', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-progress-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('streams throttled byte progress and ends with the full file size', async () => {
    const start = {
      type: 'session_start',
      ts: '2026-08-29T10:00:00.000Z',
      model: 'test-model',
      provider: 'test-provider',
    };
    const inputs = Array.from({ length: 30 }, (_, i) => ({
      type: 'user_input',
      ts: `2026-08-29T10:${String(i).padStart(2, '0')}:00.000Z`,
      content: [{ type: 'text', text: `turn-${i}-${'y'.repeat(400)}` }],
    }));
    const lines = [start, ...inputs].map((event) => JSON.stringify(event));
    const sessionFile = path.join(dir, 'sess.jsonl');
    await fsp.writeFile(sessionFile, lines.join('\n'), 'utf8');
    const totalBytes = (await fsp.stat(sessionFile)).size;

    const seen: Array<{ loadedBytes: number; totalBytes: number }> = [];
    await loadSessionDataFromFile({
      id: '2026-08-29/sess_progress',
      file: sessionFile,
      full: true,
      secretScrubber: passthroughScrubber,
      progressIntervalMs: 0,
      onLoadProgress: (progress) => seen.push({ ...progress }),
    });

    // progressIntervalMs=0 → one emit per line plus the unthrottled EOF marker.
    expect(seen.length).toBeGreaterThanOrEqual(lines.length);
    // Mid-stream accounting is monotonically non-decreasing (the per-line
    // +1 approximation only ever over-counts). The final EOF callback is
    // deliberately EXACT and may step back below the last approximation.
    for (let i = 1; i < seen.length - 1; i += 1) {
      expect(seen[i]!.loadedBytes).toBeGreaterThanOrEqual(seen[i - 1]!.loadedBytes);
    }
    const last = seen[seen.length - 1]!;
    expect(last.totalBytes).toBe(totalBytes);
    // Σ(line.length + 1) tracks the file within one newline per line.
    expect(Math.abs(last.loadedBytes - totalBytes)).toBeLessThanOrEqual(lines.length);
    // The EOF marker is the authoritative completion signal: it must report
    // the exact source size regardless of the delimiter approximation above.
    expect(last.loadedBytes).toBe(totalBytes);
  });

  it('performs no progress work when no consumer is attached', async () => {
    const start = {
      type: 'session_start',
      ts: '2026-08-29T10:00:00.000Z',
      model: 'test-model',
      provider: 'test-provider',
    };
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      type: 'user_input',
      ts: `2026-08-29T10:0${i}:00.000Z`,
      content: [{ type: 'text', text: `t-${i}` }],
    }));
    const lines = [start, ...inputs].map((event) => JSON.stringify(event));
    const sessionFile = path.join(dir, 'sess.jsonl');
    await fsp.writeFile(sessionFile, lines.join('\n'), 'utf8');

    // Without onLoadProgress the loader must not stat or account anything.
    const data = await loadSessionDataFromFile({
      id: '2026-08-29/sess_progress',
      file: sessionFile,
      full: true,
      secretScrubber: passthroughScrubber,
    });
    expect(data.messages.length).toBeGreaterThan(0);
  });

  it('reports an exact EOF size for a CRLF journal with no trailing newline', async () => {
    const start = {
      type: 'session_start',
      ts: '2026-08-29T10:00:00.000Z',
      model: 'test-model',
      provider: 'test-provider',
    };
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      type: 'user_input',
      ts: `2026-08-29T10:0${i}:00.000Z`,
      content: [{ type: 'text', text: `crlf-${i}` }],
    }));
    // CRLF delimiters + a final line WITHOUT a trailing newline: the +1-per-
    // line accounting approximates both shapes, so only the EOF marker can
    // be byte-exact.
    const lines = [start, ...inputs].map((event) => JSON.stringify(event));
    const sessionFile = path.join(dir, 'sess-crlf.jsonl');
    await fsp.writeFile(sessionFile, lines.join('\r\n'), 'utf8');
    const totalBytes = (await fsp.stat(sessionFile)).size;

    const seen: Array<{ loadedBytes: number; totalBytes: number }> = [];
    await loadSessionDataFromFile({
      id: '2026-08-29/sess_progress',
      file: sessionFile,
      full: true,
      secretScrubber: passthroughScrubber,
      progressIntervalMs: 0,
      onLoadProgress: (progress) => seen.push({ ...progress }),
    });

    const last = seen[seen.length - 1]!;
    expect(last.loadedBytes).toBe(totalBytes);
    expect(last.totalBytes).toBe(totalBytes);
  });
});

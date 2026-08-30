import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  diagnoseSessions,
  repairSessionSummaries,
  type SessionFindingCode,
} from '../../src/storage/session-doctor.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempSessions(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-session-doctor-'));
  dirs.push(dir);
  return dir;
}

const ev = (type: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ type, ts: '2026-08-29T10:00:00.000Z', ...extra })}\n`;

/** Write `<dir>/<day>/<name>.jsonl` verbatim (no trailing newline added). */
async function writeJournal(dir: string, id: string, body: string): Promise<string> {
  const file = path.join(dir, `${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  return file;
}

function codes(findings: Array<{ code: SessionFindingCode }>): SessionFindingCode[] {
  return findings.map((f) => f.code);
}

describe('diagnoseSessions', () => {
  it('reads a healthy session without inventing findings', async () => {
    const dir = await tempSessions();
    await writeJournal(
      dir,
      '2026-08-29/sess_ok',
      ev('session_start', { id: 'sess_ok', model: 'm', provider: 'p' }) +
        ev('user_input', { content: 'hi' }) +
        ev('llm_response', { content: [{ type: 'text', text: 'hello' }] }) +
        ev('session_end'),
    );
    await fs.writeFile(path.join(dir, '2026-08-29', 'sess_ok.summary.json'), '{}');

    const report = await diagnoseSessions({ sessionsDir: dir });

    expect(report.totals.sessions).toBe(1);
    expect(report.totals.unparsableLines).toBe(0);
    expect(report.sessions[0]?.lastBoundary).toBe('session_end');
    expect(codes(report.sessions[0]?.findings ?? [])).toEqual([]);
  });

  it('does not call a hyphenated or namespaced event type corruption', async () => {
    // Regression for a real false positive: a `[a-z_]+` type pattern reported
    // 16 valid `git-autocommit:commit` events in the live corpus as unparsable,
    // and 18 of the 19 "corrupt" files were not corrupt at all.
    const dir = await tempSessions();
    await writeJournal(
      dir,
      '2026-08-29/sess_plugin',
      ev('session_start', { id: 'sess_plugin' }) +
        ev('git-autocommit:commit', { hash: 'abc123', commitType: 'auto' }) +
        ev('session_end'),
    );

    const report = await diagnoseSessions({ sessionsDir: dir });

    expect(report.totals.unparsableLines).toBe(0);
    expect(codes(report.sessions[0]?.findings ?? [])).not.toContain('unparsable_lines');
  });

  it('finds a type that sits past the fast-path probe window', async () => {
    // A big leading field can push `"type"` beyond the 200-char prefix. Calling
    // that corruption would be the same class of lie as the one above.
    const dir = await tempSessions();
    const fat = 'x'.repeat(4000);
    await writeJournal(
      dir,
      '2026-08-29/sess_fat',
      `${JSON.stringify({ content: fat, ts: '2026-08-29T10:00:00.000Z', type: 'user_input' })}\n` +
        ev('session_end'),
    );

    const report = await diagnoseSessions({ sessionsDir: dir });

    expect(report.totals.unparsableLines).toBe(0);
  });

  it('reports genuinely unparsable lines', async () => {
    const dir = await tempSessions();
    await writeJournal(
      dir,
      '2026-08-29/sess_corrupt',
      ev('session_start', { id: 'sess_corrupt' }) +
        // What real corruption looks like here: UTF-16 tool output written raw
        // into the UTF-8 stream, leaving a line that is not JSON at all.
        '敲畴湲渠汵㭬਍††㐠簷\n' +
        'not json either\n' +
        ev('session_end'),
    );

    const report = await diagnoseSessions({ sessionsDir: dir });

    expect(report.totals.unparsableLines).toBe(2);
    const finding = report.sessions[0]?.findings.find((f) => f.code === 'unparsable_lines');
    expect(finding?.severity).toBe('error');
    // No fix offered: repairing these would mean editing the journal.
    expect(finding?.fix).toBeUndefined();
  });

  it('decides "died mid-turn" from the LAST boundary, not from counts', async () => {
    // Counting `in_flight_start` against `in_flight_end` misreports wildly:
    // on the live corpus that heuristic claimed 207 dead sessions where the
    // boundary rule finds 15. `in_flight_end` is written once per recovered
    // turn, not once per start.
    const dir = await tempSessions();
    await writeJournal(
      dir,
      '2026-08-29/sess_recovered',
      ev('session_start', { id: 'sess_recovered' }) +
        ev('in_flight_start').repeat(5) +
        ev('in_flight_end'),
    );
    await writeJournal(
      dir,
      '2026-08-29/sess_dead',
      ev('session_start', { id: 'sess_dead' }) + ev('in_flight_end') + ev('in_flight_start'),
    );

    const report = await diagnoseSessions({ sessionsDir: dir });
    const byId = new Map(report.sessions.map((s) => [s.id, s]));

    expect(codes(byId.get('2026-08-29/sess_recovered')?.findings ?? [])).not.toContain(
      'died_mid_turn',
    );
    expect(codes(byId.get('2026-08-29/sess_dead')?.findings ?? [])).toContain('died_mid_turn');
  });

  it('flags a journal that ends mid-write', async () => {
    const dir = await tempSessions();
    await writeJournal(
      dir,
      '2026-08-29/sess_cut',
      `${ev('session_start', { id: 'sess_cut' })}{"type":"user_inp`,
    );

    const report = await diagnoseSessions({ sessionsDir: dir });

    expect(codes(report.sessions[0]?.findings ?? [])).toContain('truncated_tail');
  });

  it('ignores underscore-prefixed stores, which are not shards', async () => {
    const dir = await tempSessions();
    await writeJournal(dir, '2026-08-29/sess_real', ev('session_start', { id: 'sess_real' }));
    await writeJournal(dir, '_trash/sess_deleted', ev('session_start', { id: 'sess_deleted' }));
    await fs.mkdir(path.join(dir, '_cas'), { recursive: true });

    const report = await diagnoseSessions({ sessionsDir: dir });

    expect(report.sessions.map((s) => s.id)).toEqual(['2026-08-29/sess_real']);
  });

  it('measures snapshot bytes without loading them', async () => {
    const dir = await tempSessions();
    const big = 'y'.repeat(50_000);
    await writeJournal(
      dir,
      '2026-08-29/sess_snap',
      ev('session_start', { id: 'sess_snap' }) +
        ev('messages_replaced', { messages: big }) +
        ev('user_input', { content: 'small' }),
    );

    const report = await diagnoseSessions({ sessionsDir: dir });

    expect(report.totals.snapshotBytes).toBeGreaterThan(50_000);
    expect(report.totals.snapshotBytes).toBeLessThan(report.totals.bytes);
  });

  it('surveys a corpus without dying on one unreadable journal', async () => {
    const dir = await tempSessions();
    await writeJournal(dir, '2026-08-29/sess_a', ev('session_start', { id: 'sess_a' }));
    await writeJournal(dir, '2026-08-29/sess_b', ev('session_start', { id: 'sess_b' }));
    const seen: string[] = [];

    const report = await diagnoseSessions({
      sessionsDir: dir,
      onProgress: ({ id }) => {
        if (id) seen.push(id);
      },
    });

    expect(report.totals.sessions).toBe(2);
    expect(report.unreadable).toEqual([]);
    expect(seen).toEqual(['2026-08-29/sess_a', '2026-08-29/sess_b']);
  });

  it('stops when the caller aborts', async () => {
    const dir = await tempSessions();
    await writeJournal(dir, '2026-08-29/sess_a', ev('session_start', { id: 'sess_a' }));
    await writeJournal(dir, '2026-08-29/sess_b', ev('session_start', { id: 'sess_b' }));
    const controller = new AbortController();

    await expect(
      diagnoseSessions({
        sessionsDir: dir,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow();
  });
});

describe('repairSessionSummaries', () => {
  it('rebuilds a missing sidecar and leaves the journal byte-identical', async () => {
    const dir = await tempSessions();
    const body =
      ev('session_start', { id: 'sess_nosum', model: 'm', provider: 'p' }) +
      ev('user_input', { content: 'what does the parser do?' }) +
      ev('llm_response', {
        content: [{ type: 'text', text: 'it splits flags' }],
        usage: { input: 120, output: 40 },
        model: 'm',
        provider: 'p',
      }) +
      ev('session_end');
    const file = await writeJournal(dir, '2026-08-29/sess_nosum', body);

    const before = await diagnoseSessions({ sessionsDir: dir });
    expect(codes(before.sessions[0]?.findings ?? [])).toContain('missing_summary');

    const result = await repairSessionSummaries({ report: before });

    expect(result.repaired).toEqual(['2026-08-29/sess_nosum']);
    expect(result.failed).toEqual([]);
    const sidecar = JSON.parse(
      await fs.readFile(path.join(dir, '2026-08-29', 'sess_nosum.summary.json'), 'utf8'),
    );
    expect(sidecar.id).toBe('2026-08-29/sess_nosum');
    expect(sidecar.title).toContain('parser');

    // THE invariant of this module: it never edits a journal.
    expect(await fs.readFile(file, 'utf8')).toBe(body);

    const after = await diagnoseSessions({ sessionsDir: dir });
    expect(codes(after.sessions[0]?.findings ?? [])).not.toContain('missing_summary');
  });

  it('still titles a session whose response is missing its usage block', async () => {
    // `usage` is required by the type but a journal is not a type, and the
    // summary builder turns ANY throw into a whole-session `(damaged)` — so one
    // malformed event used to cost the session its title in the picker.
    const dir = await tempSessions();
    await writeJournal(
      dir,
      '2026-08-29/sess_nousage',
      ev('session_start', { id: 'sess_nousage', model: 'm', provider: 'p' }) +
        ev('user_input', { content: 'why is the bar wrong?' }) +
        ev('llm_response', { content: [{ type: 'text', text: 'stale snapshot' }] }) +
        ev('session_end'),
    );

    const report = await diagnoseSessions({ sessionsDir: dir });
    await repairSessionSummaries({ report });

    const sidecar = JSON.parse(
      await fs.readFile(path.join(dir, '2026-08-29', 'sess_nousage.summary.json'), 'utf8'),
    );
    expect(sidecar.title).not.toBe('(damaged)');
    expect(sidecar.title).toContain('bar');
    expect(sidecar.model).toBe('m');
  });

  it('rewrites a sidecar that fell behind its transcript', async () => {
    const dir = await tempSessions();
    await writeJournal(
      dir,
      '2026-08-29/sess_stale',
      ev('session_start', { id: 'sess_stale' }) + ev('user_input', { content: 'later question' }),
    );
    const sidecar = path.join(dir, '2026-08-29', 'sess_stale.summary.json');
    await fs.writeFile(sidecar, '{"id":"2026-08-29/sess_stale","title":"outdated"}');
    // Backdate the sidecar so it is unambiguously older than the transcript.
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(sidecar, old, old);

    const report = await diagnoseSessions({ sessionsDir: dir });
    expect(codes(report.sessions[0]?.findings ?? [])).toContain('stale_summary');

    await repairSessionSummaries({ report });

    const rebuilt = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    expect(rebuilt.title).toContain('later question');
  });

  it('touches nothing when there is nothing to repair', async () => {
    const dir = await tempSessions();
    await writeJournal(dir, '2026-08-29/sess_ok', ev('session_start', { id: 'sess_ok' }));
    await fs.writeFile(path.join(dir, '2026-08-29', 'sess_ok.summary.json'), '{}');

    const report = await diagnoseSessions({ sessionsDir: dir });
    const result = await repairSessionSummaries({ report });

    expect(result.repaired).toEqual([]);
    // The stub sidecar is left exactly as found — it is not stale.
    expect(await fs.readFile(path.join(dir, '2026-08-29', 'sess_ok.summary.json'), 'utf8')).toBe(
      '{}',
    );
  });

  it('reports a per-session failure instead of aborting the batch', async () => {
    const dir = await tempSessions();
    await writeJournal(dir, '2026-08-29/sess_gone', ev('session_start', { id: 'sess_gone' }));
    await writeJournal(dir, '2026-08-29/sess_kept', ev('session_start', { id: 'sess_kept' }));

    const report = await diagnoseSessions({ sessionsDir: dir });
    // Vanishes between the scan and the repair — the corpus is exactly where
    // files move under you.
    await fs.rm(path.join(dir, '2026-08-29', 'sess_gone.jsonl'));

    const result = await repairSessionSummaries({ report });

    expect(result.repaired).toEqual(['2026-08-29/sess_kept']);
    expect(result.failed.map((f) => f.id)).toEqual(['2026-08-29/sess_gone']);
  });
});

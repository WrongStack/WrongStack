import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchTool } from '../src/patch.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('patchTool', () => {
  it('has correct metadata', () => {
    expect(patchTool.name).toBe('patch');
    expect(patchTool.permission).toBe('confirm');
    expect(patchTool.mutating).toBe(true);
    expect(patchTool.inputSchema.required).toContain('patch');
  });

  it('throws when patch is empty', async () => {
    const ctx = makeCtx();
    await expect(patchTool.execute({ patch: '' }, ctx, makeOpts())).rejects.toThrow();
  });

  it('throws when patch is null', async () => {
    const ctx = makeCtx();
    await expect(patchTool.execute({ patch: null as any }, ctx, makeOpts())).rejects.toThrow();
  });

  it('refuses (throws) a dry run whose targets strip to nothing', async () => {
    const ctx = makeCtx();
    await expect(
      patchTool.execute(
        { patch: '--- fake\n+++ fake\n@@ -1,1 +1,1 @@\n-old\n+new', dry_run: true },
        ctx,
        makeOpts(),
      ),
    ).rejects.toThrow(/patch refused/);
  });

  it('refuses (throws) when strip removes every path component', async () => {
    const ctx = makeCtx();
    await expect(
      patchTool.execute({ patch: '--- a\n+++ b\n@@ -1 @@\n-old\n+new', strip: 2 }, ctx, makeOpts()),
    ).rejects.toThrow(/patch refused/);
  });

  it('throws when the patch fails to apply (target file missing)', async () => {
    const ctx = makeCtx();
    await expect(
      patchTool.execute(
        { patch: '--- a/fake.txt\n+++ b/fake.txt\n@@ -1 @@\n-old\n+new' },
        ctx,
        makeOpts(),
      ),
    ).rejects.toThrow();
  });

  it('rejects a diff whose target resolves outside the project root', async () => {
    const ctx = makeCtx();
    // strip=1 trims one component; the remaining path "../../etc/passwd"
    // resolves outside tmpDir.
    const evilPatch = '--- a/foo\n+++ b/../../etc/passwd\n@@ -1 @@\n-old\n+new';
    await expect(patchTool.execute({ patch: evilPatch }, ctx, makeOpts())).rejects.toThrow(
      /outside project root/,
    );
  });

  it('forces strip >= 1 — strip=0 is treated as 1', async () => {
    // With strip=0 an attacker could put absolute paths in +++ targets.
    // The tool clamps strip to >= 1 internally. We can't observe the
    // clamp directly via the API, but we can verify that strip=0 with
    // a target that ONLY works at strip=0 doesn't escape: pass
    // /tmp/absolute as the target and confirm rejection.
    const ctx = makeCtx();
    const evilPatch = '--- /etc/passwd\n+++ /etc/passwd\n@@ -1 @@\n-old\n+new';
    await expect(
      patchTool.execute({ patch: evilPatch, strip: 0 }, ctx, makeOpts()),
    ).rejects.toThrow(/patch refused/);
  });

  it('rejects targets where GNU patch -pN yields a ../ escape (leading-slash divergence)', async () => {
    // GNU patch counts "slashes along with the directory names between them"
    // where adjacent slashes count as one. For /../etc/passwd with -p1, GNU
    // patch strips the leading slash and yields ../etc/passwd — which escapes
    // root. The old preflight filtered empty segments from the split, yielding
    // etc/passwd (in-root) — a containment bypass.
    const ctx = makeCtx();
    const evilPatch = '--- a/foo\n+++ /../etc/passwd\n@@ -1 @@\n-old\n+new';
    await expect(patchTool.execute({ patch: evilPatch }, ctx, makeOpts())).rejects.toThrow(
      /outside project root/,
    );
  });

  it('rejects out-of-root target after a hunk ending with a stripped-blank context line', async () => {
    // A blank context line that lost its leading space (line[0] === undefined)
    // used to skip both counter decrements, leaving inHunk=true. The next
    // file's ---/+++ headers were then consumed as hunk content and never
    // reached the file-header matcher — defeating the path-containment
    // pre-flight so GNU patch could write outside the project root.
    const ctx = makeCtx();
    const evilPatch =
      '--- a/foo.txt\n' +
      '+++ b/foo.txt\n' +
      '@@ -1,2 +1,2 @@\n' +
      ' line1\n' +
      '-old\n' +
      '+new\n' +
      '\n' + // stripped-blank context line (no leading space)
      '--- a/bar.txt\n' +
      '+++ b/../../etc/passwd\n' +
      '@@ -1 @@\n-old\n+evil';
    await expect(patchTool.execute({ patch: evilPatch }, ctx, makeOpts())).rejects.toThrow(
      /outside project root/,
    );
  });

  it('does not misparse hunk-body content lines as file headers', async () => {
    // An added line whose content is "++ ../../etc/passwd" appears in the
    // diff as "+++ ../../etc/passwd". The old parser matched ^\+\+\+ outside
    // hunk-tracking and created a phantom target that, after strip, escaped
    // root — a spurious refusal of a valid patch. Hunk-state tracking ensures
    // the line is consumed as content.
    const ctx = makeCtx();
    const patchBody =
      '--- a/code.txt\n' +
      '+++ b/code.txt\n' +
      '@@ -1,2 +1,3 @@\n' +
      ' line1\n' +
      '+++ ../../etc/passwd\n' +
      ' line2\n';
    // code.txt does not exist, so the engine may fail — but never with a
    // containment refusal caused by a phantom target.
    const outcome = await patchTool.execute({ patch: patchBody }, ctx, makeOpts()).then(
      (r) => r.message,
      (e: Error) => e.message,
    );
    expect(outcome).not.toMatch(/outside project root/);
  });

  it('correctly parses and applies patches with quoted file targets', async () => {
    const file = path.join(tmpDir, 'quoted-test.txt');
    await fs.writeFile(file, 'initial\n');
    const ctx = makeCtx();
    const patchBody =
      '--- "a/quoted-test.txt"\n' +
      '+++ "b/quoted-test.txt"\n' +
      '@@ -1 +1 @@\n' +
      '-initial\n' +
      '+updated\n';
    const result = await patchTool.execute({ patch: patchBody }, ctx, makeOpts());
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(result.rejected).toBe(0);
    const after = await fs.readFile(file, 'utf8');
    expect(after).toContain('updated');
  });
});

describe('patchTool — bookkeeping on every outcome', () => {
  const makeTrackingCtx = () => {
    const changes: Array<{ path: string; action: string; before: string | null }> = [];
    const ctx = {
      cwd: tmpDir,
      tools: [],
      projectRoot: tmpDir,
      session: {
        recordFileChange: (c: { path: string; action: string; before: string | null }) =>
          changes.push(c),
      },
      recordRead: () => {},
    } as any;
    return { ctx, changes };
  };

  // `+++ /dev/null` is how a unified diff spells a deletion. `extractDiffTargets`
  // skipped it, so the target list came back EMPTY: no containment check, no
  // before-snapshot, no rewind record — while `applied` was still reported from
  // GNU patch's stdout. The file was gone and rewind could not bring it back.
  it('records a deletion diff so rewind can restore the file', async () => {
    const file = path.join(tmpDir, 'gone.txt');
    await fs.writeFile(file, 'line1\n');
    const { ctx, changes } = makeTrackingCtx();

    const result = await patchTool.execute(
      {
        patch: '--- a/gone.txt\n' + '+++ /dev/null\n' + '@@ -1 +0,0 @@\n' + '-line1\n',
      },
      ctx,
      makeOpts(),
    );

    // Assert against the recorded actions rather than a bare `toBeDefined()`:
    // this has failed intermittently under full-suite load, and the bare form
    // reported only "expected undefined to be defined" — which cannot
    // distinguish "GNU patch left the file in place" (bookkeeping records
    // 'modified', or nothing at all when the content is byte-identical) from
    // "the target was never resolved". The actions plus patch's own stdout
    // name the branch that ran.
    const deletion = changes.find((c) => c.action === 'deleted');
    expect(
      changes.map((c) => c.action),
      `patch reported: ${JSON.stringify(result)}`,
    ).toContain('deleted');
    expect(deletion?.before).toBe('line1\n');
    expect(path.resolve(deletion!.path)).toBe(path.resolve(file));
  });

  // An existing file over the 5 MB tracking cap has no `before` snapshot. It
  // was recorded as 'created' once the patch shrank it under the cap, so a
  // rewind deleted the user's file.
  it('records an untrackable existing file as modified, never created', async () => {
    const file = path.join(tmpDir, 'big.txt');
    const longLine = 'x'.repeat(300_000);
    await fs.writeFile(file, `${longLine}\nkeep\n${'y'.repeat(5_000_000)}`);
    const { ctx, changes } = makeTrackingCtx();

    await patchTool.execute(
      {
        patch: `--- a/big.txt\n+++ b/big.txt\n@@ -1,2 +1,2 @@\n-${longLine}\n+short\n keep\n`,
      },
      ctx,
      makeOpts(),
    );

    expect(changes.map((c) => c.action)).toEqual(['modified']);
    expect(changes[0]?.before).toBeNull();
  });

  // A Latin-1 file snapshotted as U+FFFD; a rewind wrote that over the file.
  it('does not record a lossy snapshot for a legacy-encoded file', async () => {
    const file = path.join(tmpDir, 'latin.txt');
    await fs.writeFile(
      file,
      Buffer.concat([Buffer.from('alpha\nkeep\n'), Buffer.from('caf\xe9\n', 'latin1')]),
    );
    const { ctx, changes } = makeTrackingCtx();

    await patchTool.execute(
      { patch: '--- a/latin.txt\n+++ b/latin.txt\n@@ -1,2 +1,2 @@\n-alpha\n+beta\n keep\n' },
      ctx,
      makeOpts(),
    );

    expect((await fs.readFile(file)).includes(0xe9)).toBe(true);
    expect(changes.some((c) => typeof c.before === 'string' && c.before.includes('�'))).toBe(false);
  });

  // `--merge` writes conflict markers INTO the file and exits non-zero. The
  // early return used to sit ABOVE the bookkeeping block, so the file was
  // corrupted on disk with no rewind record and the model was told `applied: 0`.
  it('records the change when a --merge conflict modifies the file anyway', async () => {
    const file = path.join(tmpDir, 'conflict.txt');
    await fs.writeFile(file, 'line1\nDIVERGED\nline3\n');
    const { ctx, changes } = makeTrackingCtx();

    // The conflict fails the call; the bookkeeping must still have run.
    const error = await patchTool
      .execute(
        {
          patch:
            '--- a/conflict.txt\n' +
            '+++ b/conflict.txt\n' +
            '@@ -1,3 +1,3 @@\n' +
            ' line1\n' +
            '-line2\n' +
            '+CHANGED\n' +
            ' line3\n',
        },
        ctx,
        makeOpts(),
      )
      .then(
        () => undefined,
        (e: Error) => e,
      );
    expect(error, 'a conflicting hunk must fail the call').toBeInstanceOf(Error);

    const after = await fs.readFile(file, 'utf8');
    if (after !== 'line1\nDIVERGED\nline3\n') {
      // GNU patch touched the file — the tool must have said so.
      expect(changes.length).toBeGreaterThan(0);
      expect(error?.message).toContain('conflict.txt');
    }
    // GNU patch's backup-if-mismatch default left `conflict.txt.orig` behind
    // while the usage text promised no .orig/.rej files.
    expect((await fs.readdir(tmpDir)).sort()).toEqual(['conflict.txt']);
  });

  it('keeps a .orig file that existed before the patch ran', async () => {
    const file = path.join(tmpDir, 'kept.txt');
    await fs.writeFile(file, 'line1\nDIVERGED\nline3\n');
    await fs.writeFile(`${file}.orig`, 'the user’s own backup\n');
    await patchTool
      .execute(
        { patch: '--- a/kept.txt\n+++ b/kept.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+X\n line3\n' },
        makeTrackingCtx().ctx,
        makeOpts(),
      )
      .catch(() => undefined);
    expect(await fs.readFile(`${file}.orig`, 'utf8')).toBe('the user’s own backup\n');
  });

  it('safely executes without opts and falls back to ctx.signal or default signal', async () => {
    const ctx = makeCtx();
    // Unparseable targets are refused before any signal is consulted by an
    // engine; the call must fail cleanly (not crash) with or without opts.
    const optsOmitted = undefined as unknown as { signal: AbortSignal };
    await expect(
      patchTool.execute(
        { patch: '--- fake\n+++ fake\n@@ -1,1 +1,1 @@\n-old\n+new', dry_run: true },
        ctx,
        optsOmitted,
      ),
    ).rejects.toThrow(/patch refused/);

    const ac = new AbortController();
    const ctxWithSignal = { ...ctx, signal: ac.signal };
    await expect(
      patchTool.execute(
        { patch: '--- fake\n+++ fake\n@@ -1,1 +1,1 @@\n-old\n+new', dry_run: true },
        ctxWithSignal,
        optsOmitted,
      ),
    ).rejects.toThrow(/patch refused/);
  });
});

describe('patchTool — VULN-001 containment (git extended headers, fail-closed)', () => {
  // VULN-001 (security-report 2026-09-03): extractDiffTargets parsed only
  // ---/+++ lines, so a diff built purely from `diff --git` / `rename` /
  // `copy` headers yielded an EMPTY target list, the containment preflight
  // never ran, and `git apply --unsafe-paths` could write outside the
  // project root. These tests are the red-first attack suite: the escape
  // tests were written against the unfixed code and failed there.
  const escapeNames = [
    'vuln-001-esc-rename.txt',
    'vuln-001-esc-copy.txt',
    'vuln-001-esc-unq.txt',
    'vuln-001-esc-q.txt',
  ];
  const escapedAbs = (name: string) => path.resolve(tmpDir, '..', name);

  afterEach(async () => {
    // Red-state safety net: before the fix an escape could actually land
    // next to the sandbox via the git fallback. Never leave it behind.
    for (const name of escapeNames) {
      await fs.rm(escapedAbs(name), { force: true });
    }
  });

  const expectGone = async (name: string) => {
    const stat = await fs.stat(escapedAbs(name)).catch(() => null);
    expect(stat, `${name} must not exist outside the project root`).toBeNull();
  };

  it('refuses a header-only rename diff whose target escapes the project root', async () => {
    const ctx = makeCtx();
    const evil =
      'diff --git a/inside.txt b/../vuln-001-esc-rename.txt\n' +
      'rename from a/inside.txt\n' +
      'rename to b/../vuln-001-esc-rename.txt\n';
    await expect(patchTool.execute({ patch: evil }, ctx, makeOpts())).rejects.toThrow(
      'patch refused',
    );
    await expectGone('vuln-001-esc-rename.txt');
  });

  it('refuses a header-only copy diff whose target escapes the project root', async () => {
    const ctx = makeCtx();
    const evil =
      'diff --git a/inside.txt b/../vuln-001-esc-copy.txt\n' +
      'copy from a/inside.txt\n' +
      'copy to b/../vuln-001-esc-copy.txt\n';
    await expect(patchTool.execute({ patch: evil }, ctx, makeOpts())).rejects.toThrow(
      'patch refused',
    );
    await expectGone('vuln-001-esc-copy.txt');
  });

  it('refuses an unquoted `diff --git` header whose b-side escapes the root', async () => {
    const ctx = makeCtx();
    const evil = 'diff --git a/ok.txt b/../vuln-001-esc-unq.txt\n';
    await expect(patchTool.execute({ patch: evil }, ctx, makeOpts())).rejects.toThrow(
      'patch refused',
    );
    await expectGone('vuln-001-esc-unq.txt');
  });

  it('refuses a quoted `diff --git` header whose quoted b-side escapes the root', async () => {
    const ctx = makeCtx();
    const evil = 'diff --git "a/ok.txt" "b/../vuln-001-esc-q.txt"\n';
    await expect(patchTool.execute({ patch: evil }, ctx, makeOpts())).rejects.toThrow(
      'patch refused',
    );
    await expectGone('vuln-001-esc-q.txt');
  });

  it('fails closed: a non-empty patch with zero parseable targets is refused', async () => {
    // An unparsed diff is an unchecked diff. Before the fix this sailed
    // past the preflight (empty target list) straight into the engines.
    const ctx = makeCtx();
    await expect(
      patchTool.execute(
        { patch: 'just some text\nwith no diff headers at all\n' },
        ctx,
        makeOpts(),
      ),
    ).rejects.toThrow('patch refused');
  });

  it('does not spuriously refuse a legitimate in-root header-only rename (no over-blocking)', async () => {
    // Containment contract only. Neither engine actually applies header-only
    // renames in a plain sandbox — GNU patch sees no hunks ("Only garbage"),
    // and `git apply` skips renames without an index context ("Skipped
    // patch", exit 0) or errors, depending on repo discovery from the cwd.
    // What must hold is that the extended-header parse produced containment
    // TARGETS, so an in-root rename passes the preflight unrefused; engine
    // applied/rejected counts are environment-dependent and not asserted.
    const ctx = makeCtx();
    const oldFile = path.join(tmpDir, 'ren.txt');
    await fs.writeFile(oldFile, 'keep me\n');
    const legit =
      'diff --git a/ren.txt b/ren2.txt\n' + 'rename from a/ren.txt\n' + 'rename to b/ren2.txt\n';
    // Engine outcome (apply vs. "Only garbage" failure) is environment-dependent;
    // only the containment verdict is asserted, on whichever path settled.
    const outcome = await patchTool.execute({ patch: legit }, ctx, makeOpts()).then(
      (r) => r.message,
      (e: Error) => e.message,
    );
    expect(outcome).not.toContain('patch refused');
    expect(outcome).not.toMatch(/outside project root/);
  });

  it('still applies a quoted combined diff (--git + ---/+++ + hunk) in-root', async () => {
    const ctx = makeCtx();
    const file = path.join(tmpDir, 'sp ace.txt');
    await fs.writeFile(file, 'old\n');
    const legit =
      'diff --git "a/sp ace.txt" "b/sp ace.txt"\n' +
      '--- "a/sp ace.txt"\n' +
      '+++ "b/sp ace.txt"\n' +
      '@@ -1 +1 @@\n' +
      '-old\n' +
      '+new\n';
    const result = await patchTool.execute({ patch: legit }, ctx, makeOpts());
    expect(result.message).not.toContain('patch refused');
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(file, 'utf8')).toContain('new');
  });

  it('exposes its destinations through writeTargets for the permission layer', () => {
    // VULN-001 Phase 2: the confirm prompt keyed on `directory` (".") and
    // never showed what the patch would actually touch.
    const wt = (patchTool as { writeTargets?: (input: unknown) => string[] }).writeTargets;
    expect(typeof wt).toBe('function');
    if (typeof wt !== 'function') return;

    // Realistic rename-with-modification: both sides visible after -p1.
    const renameWithHunk =
      'diff --git a/src/keep.ts b/src/moved.ts\n' +
      'rename from a/src/keep.ts\n' +
      'rename to b/src/moved.ts\n' +
      '--- a/src/keep.ts\n' +
      '+++ b/src/moved.ts\n' +
      '@@ -1 +1 @@\n' +
      '-old\n' +
      '+new\n';
    const targets = wt({ patch: renameWithHunk });
    expect(targets).toContain('src/keep.ts');
    expect(targets).toContain('src/moved.ts');

    // An escaping destination must be visible to the agent-state gate, not
    // hidden behind the innocuous `directory` subject.
    const evil = 'diff --git a/x.txt b/../esc.txt\nrename from a/x.txt\nrename to b/../esc.txt\n';
    expect(wt({ patch: evil })).toContain('../esc.txt');

    // Strip honoured (a/p/q.txt with strip 2 → q.txt), garbage → no targets.
    expect(wt({ patch: '--- a/p/q.txt\n+++ b/p/q.txt\n', strip: 2 })).toContain('q.txt');
    expect(wt({ patch: '' })).toEqual([]);
    expect(wt({ patch: 'not a diff at all\n' })).toEqual([]);

    // Plain unified diff without `diff --git` where `---` and `+++` differ:
    // both sides must be extracted so escaping `---` targets are caught.
    const unifiedMismatch = '--- a/../../outside.txt\n+++ b/inside.txt\n@@ -1 +1 @@\n-old\n+new\n';
    expect(wt({ patch: unifiedMismatch })).toContain('../../outside.txt');
    expect(wt({ patch: unifiedMismatch })).toContain('inside.txt');
  });

  it('refuses a plain unified diff whose --- header escapes the project root', async () => {
    const ctx = makeCtx();
    const evilUnified = '--- a/../../outside.txt\n+++ b/inside.txt\n@@ -1 +1 @@\n-old\n+new\n';
    await expect(
      patchTool.execute({ patch: evilUnified, dry_run: true }, ctx, makeOpts()),
    ).rejects.toThrow('patch refused');
  });

  it('does not let a zero-line hunk swallow a subsequent escaping --- header (F222)', () => {
    const wt = patchTool.writeTargets!;
    const bypass = [
      '--- a/safe.txt',
      '+++ b/safe.txt',
      '@@ -0,0 +0,0 @@',
      '--- a/../../secret.txt',
      '+++ /dev/null',
    ].join('\n');
    expect(wt({ patch: bypass, strip: 1 })).toContain('../../secret.txt');
  });
});

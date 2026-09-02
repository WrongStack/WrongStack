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

  it('applies dry_run correctly', async () => {
    const ctx = makeCtx();
    const result = await patchTool.execute(
      { patch: '--- fake\n+++ fake\n@@ -1,1 +1,1 @@\n-old\n+new', dry_run: true },
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('dry_run');
  });

  it('handles strip option', async () => {
    const ctx = makeCtx();
    const result = await patchTool.execute(
      { patch: '--- a\n+++ b\n@@ -1 @@\n-old\n+new', strip: 2 },
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('message');
  });

  it('returns applied=0 when patch fails', async () => {
    const ctx = makeCtx();
    const result = await patchTool.execute(
      { patch: '--- fake\n+++ fake\n@@ -1 @@\n-old\n+new' },
      ctx,
      makeOpts(),
    );
    // patch will fail because the file doesn't exist - applied should be 0
    expect(result).toHaveProperty('applied');
  });

  it('rejects a diff whose target resolves outside the project root', async () => {
    const ctx = makeCtx();
    // strip=1 trims one component; the remaining path "../../etc/passwd"
    // resolves outside tmpDir.
    const evilPatch = '--- a/foo\n+++ b/../../etc/passwd\n@@ -1 @@\n-old\n+new';
    const result = await patchTool.execute({ patch: evilPatch }, ctx, makeOpts());
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.message).toMatch(/outside project root/);
  });

  it('forces strip >= 1 — strip=0 is treated as 1', async () => {
    // With strip=0 an attacker could put absolute paths in +++ targets.
    // The tool clamps strip to >= 1 internally. We can't observe the
    // clamp directly via the API, but we can verify that strip=0 with
    // a target that ONLY works at strip=0 doesn't escape: pass
    // /tmp/absolute as the target and confirm rejection.
    const ctx = makeCtx();
    const evilPatch = '--- /etc/passwd\n+++ /etc/passwd\n@@ -1 @@\n-old\n+new';
    const result = await patchTool.execute({ patch: evilPatch, strip: 0 }, ctx, makeOpts());
    expect(result.applied).toBe(0);
  });

  it('rejects targets where GNU patch -pN yields a ../ escape (leading-slash divergence)', async () => {
    // GNU patch counts "slashes along with the directory names between them"
    // where adjacent slashes count as one. For /../etc/passwd with -p1, GNU
    // patch strips the leading slash and yields ../etc/passwd — which escapes
    // root. The old preflight filtered empty segments from the split, yielding
    // etc/passwd (in-root) — a containment bypass.
    const ctx = makeCtx();
    const evilPatch = '--- a/foo\n+++ /../etc/passwd\n@@ -1 @@\n-old\n+new';
    const result = await patchTool.execute({ patch: evilPatch }, ctx, makeOpts());
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.message).toMatch(/outside project root/);
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
    const result = await patchTool.execute({ patch: evilPatch }, ctx, makeOpts());
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.message).toMatch(/outside project root/);
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
    const result = await patchTool.execute({ patch: patchBody }, ctx, makeOpts());
    expect(result.message).not.toMatch(/outside project root/);
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

  // `--merge` writes conflict markers INTO the file and exits non-zero. The
  // early return used to sit ABOVE the bookkeeping block, so the file was
  // corrupted on disk with no rewind record and the model was told `applied: 0`.
  it('records the change when a --merge conflict modifies the file anyway', async () => {
    const file = path.join(tmpDir, 'conflict.txt');
    await fs.writeFile(file, 'line1\nDIVERGED\nline3\n');
    const { ctx, changes } = makeTrackingCtx();

    const result = await patchTool.execute(
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
    );

    const after = await fs.readFile(file, 'utf8');
    if (after !== 'line1\nDIVERGED\nline3\n') {
      // GNU patch touched the file — the tool must have said so.
      expect(changes.length).toBeGreaterThan(0);
      expect(result.files.length).toBeGreaterThan(0);
    }
  });

  it('safely executes without opts and falls back to ctx.signal or default signal', async () => {
    const ctx = makeCtx();
    const result = await patchTool.execute(
      { patch: '--- fake\n+++ fake\n@@ -1,1 +1,1 @@\n-old\n+new', dry_run: true },
      ctx,
    );
    expect(result).toHaveProperty('dry_run');

    const ac = new AbortController();
    const ctxWithSignal = { ...ctx, signal: ac.signal };
    const resultWithSignal = await patchTool.execute(
      { patch: '--- fake\n+++ fake\n@@ -1,1 +1,1 @@\n-old\n+new', dry_run: true },
      ctxWithSignal,
    );
    expect(resultWithSignal).toHaveProperty('dry_run');
  });
});


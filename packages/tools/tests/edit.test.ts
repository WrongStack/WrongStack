import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editTool } from '../src/edit.js';
import { readTool } from '../src/read.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

describe('edit tool', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('validates required inputs', async () => {
    const sig = { signal: newSignal() };
    await expect(
      editTool.execute({ path: '', old_string: 'a', new_string: 'b' }, sb.ctx, sig),
    ).rejects.toThrow(/path is required/);
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: undefined as never, new_string: 'b' },
        sb.ctx,
        sig,
      ),
    ).rejects.toThrow(/old_string is required/);
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: 'a', new_string: undefined as never },
        sb.ctx,
        sig,
      ),
    ).rejects.toThrow(/new_string is required/);
    await expect(
      editTool.execute({ path: 'a.txt', old_string: '', new_string: 'b' }, sb.ctx, sig),
    ).rejects.toThrow(/cannot be empty/);
  });

  it('rejects a directory (not a regular file)', async () => {
    await fs.mkdir(path.join(sb.dir, 'adir'));
    await expect(
      editTool.execute({ path: 'adir', old_string: 'a', new_string: 'b' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('aborted signal leaves the file untouched', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'hello world');
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      editTool.execute({ path: 'a.txt', old_string: 'hello', new_string: 'bye' }, sb.ctx, {
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8')).toBe('hello world');
  });

  it('honors ctx.signal when opts is omitted and ctx.signal is aborted', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'hello world');
    const ctrl = new AbortController();
    ctrl.abort();
    const ctxWithSignal = { ...sb.ctx, signal: ctrl.signal };
    await expect(
      editTool.execute({ path: 'a.txt', old_string: 'hello', new_string: 'bye' }, ctxWithSignal as any),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8')).toBe('hello world');
  });


  it('auto-reads when no prior read is recorded and the edit is unambiguous', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'hello world');
    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.replacements).toBe(1);
    expect(out.note).toMatch(/auto-read/);
    expect(await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8')).toBe('hi world');
  });

  it('single replacement succeeds', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'hello world');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.replacements).toBe(1);
    const content = await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8');
    expect(content).toBe('hi world');
  });

  it('multi-match without replace_all fails with line numbers', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'foo\nfoo\nfoo\n');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    await expect(
      editTool.execute({ path: 'a.txt', old_string: 'foo', new_string: 'bar' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/matched 3 times/);
  });

  it('auto-read still refuses ambiguous edits', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'foo\nfoo\nfoo\n');
    await expect(
      editTool.execute({ path: 'a.txt', old_string: 'foo', new_string: 'bar' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/matched 3 times/);
    expect(await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8')).toBe('foo\nfoo\nfoo\n');
  });

  it('replace_all replaces all occurrences', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'foo\nfoo\nfoo\n');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.replacements).toBe(3);
    const content = await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8');
    expect(content).toBe('bar\nbar\nbar\n');
  });

  it('no-match throws with helpful message', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'apple');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    await expect(
      editTool.execute({ path: 'a.txt', old_string: 'banana', new_string: 'x' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/no match/);
  });

  it('CRLF file is preserved', async () => {
    await fs.writeFile(path.join(sb.dir, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    await readTool.execute({ path: 'crlf.txt' }, sb.ctx, { signal: newSignal() });
    await editTool.execute({ path: 'crlf.txt', old_string: 'two', new_string: 'TWO' }, sb.ctx, {
      signal: newSignal(),
    });
    const content = await fs.readFile(path.join(sb.dir, 'crlf.txt'), 'utf8');
    expect(content).toBe('one\r\nTWO\r\nthree\r\n');
  });

  it('no-op (old===new) is success', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'same');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'same', new_string: 'same' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.replacements).toBe(0);
  });

  it('old===new with text ABSENT from the file throws no-match, not a benign no-op', async () => {
    // Wrong-target guard: a redundant edit (text already present) and a
    // mistargeted edit (text nowhere in the file) must be distinguishable.
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'actual content');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    await expect(
      editTool.execute(
        { path: 'a.txt', old_string: 'phantom text', new_string: 'phantom text' },
        sb.ctx,
        { signal: newSignal() },
      ),
    ).rejects.toThrow(/no match/);
  });

  it('empty old_string is rejected', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.txt'), 'x');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    await expect(
      editTool.execute({ path: 'a.txt', old_string: '', new_string: 'y' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/empty/);
  });

  it('missing file fails with hint', async () => {
    await expect(
      editTool.execute({ path: 'missing.txt', old_string: 'x', new_string: 'y' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('flags external modification when the content changed since the read', async () => {
    const file = path.join(sb.dir, 'a.txt');
    await fs.writeFile(file, 'hello');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    // Change the content behind the agent's back. The hash arbiter catches
    // this even inside the mtime tolerance window (2 s on Windows).
    await fs.writeFile(file, 'hello, changed');
    await expect(
      editTool.execute({ path: 'a.txt', old_string: 'hello', new_string: 'hi' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/modified externally/);
  });

  it('a content-preserving mtime bump (touch) does not block the edit', async () => {
    const file = path.join(sb.dir, 'a.txt');
    await fs.writeFile(file, 'hello');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    // mtime advances past tolerance but the content hash is unchanged —
    // the model's picture of the file is still accurate, so editing is safe.
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(file, future, future);
    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.replacements).toBe(1);
  });

  it('falls back to the mtime check when no content hash was recorded', async () => {
    const file = path.join(sb.dir, 'a.txt');
    await fs.writeFile(file, 'hello');
    // Simulate an older/duck-typed recordRead that stored only the mtime.
    const stat = await fs.stat(file);
    sb.ctx.recordRead(await fs.realpath(file), stat.mtimeMs);
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(file, future, future);
    await expect(
      editTool.execute({ path: 'a.txt', old_string: 'hello', new_string: 'hi' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/modified externally/);
  });

  it('accepts a re-edit when mtime is within tolerance', async () => {
    // Write and edit twice in quick succession. On Windows FAT, the second
    // edit's stat may report an unchanged mtime; on Linux it advances by
    // ~µs. Either way it must fall within tolerance and not trip the stale-
    // read guard.
    const file = path.join(sb.dir, 'a.txt');
    await fs.writeFile(file, 'hello world');
    await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    const first = await editTool.execute(
      { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(first.replacements).toBe(1);

    const second = await editTool.execute(
      { path: 'a.txt', old_string: 'world', new_string: 'there' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(second.replacements).toBe(1);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('hi there');
  });

  describe('lineNumbersFor multi-match', () => {
    it('lineNumbersFor converts indices to correct line numbers for multiple matches', async () => {
      // A file with three matches of "foo" at different lines.
      // lineNumbersFor should return the correct line numbers for each match index.
      const file = path.join(sb.dir, 'multi.txt');
      const content = 'line1 foo\nline2 foo\nline3 foo\n';
      await fs.writeFile(file, content);
      await readTool.execute({ path: 'multi.txt' }, sb.ctx, { signal: newSignal() });

      // Attempt an edit with 'foo' but without replace_all — this should throw
      // with the line numbers of the matches. We exercise it through the error message.
      await expect(
        editTool.execute({ path: 'multi.txt', old_string: 'foo', new_string: 'bar' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/matched 3 times/);
    });
  });

  describe('findSimilarity long-needle near-match', () => {
    it('findSimilarity is called and returns a hint when needle >= 20 chars has a near match', async () => {
      // The probe (first 40 chars of needle) must appear in the file for findSimilarity to return a line.
      // File contains the probe directly so findSimilarity finds it.
      const file = path.join(sb.dir, 'near.txt');
      const fileContent = 'Hello world testingzzz different suffix here is the rest of the file';
      await fs.writeFile(file, fileContent);
      // needle = same as file content with a trailing change
      const needle = 'Hello world testingzzz different suffix here is not there';
      await readTool.execute({ path: 'near.txt' }, sb.ctx, { signal: newSignal() });

      await expect(
        editTool.execute({ path: 'near.txt', old_string: needle, new_string: 'replaced' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/Nearest match near line/);
    });

    it('reports the correct line when the near match is on a later line', async () => {
      // A newline precedes the probe match, so findSimilarity counts past it.
      const file = path.join(sb.dir, 'multi.txt');
      const probeLine = 'Hello world testingzzz different suffix here is the rest';
      await fs.writeFile(file, `first line\nsecond line\n${probeLine}`);
      const needle = 'Hello world testingzzz different suffix here is NOT present';
      await readTool.execute({ path: 'multi.txt' }, sb.ctx, { signal: newSignal() });

      await expect(
        editTool.execute({ path: 'multi.txt', old_string: needle, new_string: 'x' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/Nearest match near line 3/);
    });

    it('findSimilarity returns undefined when needle >= 20 chars with no near match in file', async () => {
      // Needle >= 20 chars but no probe match at all in the file
      // findSimilarity returns undefined → no "near line" hint in error
      const file = path.join(sb.dir, 'far.txt');
      const needle = 'zzzz no match in this file at all xxxx'; // 35 chars, probe won't be found
      await fs.writeFile(file, 'completely unrelated content');
      await readTool.execute({ path: 'far.txt' }, sb.ctx, { signal: newSignal() });

      await expect(
        editTool.execute({ path: 'far.txt', old_string: needle, new_string: 'replaced' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/no match/);
    });
  });

  describe('matching ladder fallbacks', () => {
    it('exact match reports matched_by: exact and no fallback note', async () => {
      await fs.writeFile(path.join(sb.dir, 'a.txt'), 'hello world');
      await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
      const out = await editTool.execute(
        { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.matched_by).toBe('exact');
      expect(out.note).toBeUndefined();
    });

    it('trailing whitespace in old_string falls back to tier 2', async () => {
      await fs.writeFile(path.join(sb.dir, 'a.txt'), 'const a = 1;\nconst b = 2;\n');
      await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
      const out = await editTool.execute(
        // Model hallucinated trailing spaces after the semicolon.
        { path: 'a.txt', old_string: 'const a = 1;   ', new_string: 'const a = 42;' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.matched_by).toBe('trailing-whitespace');
      expect(out.note).toMatch(/did not match exactly/);
      expect(out.note).toMatch(/confidence: high/);
      const content = await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8');
      expect(content).toBe('const a = 42;\nconst b = 2;\n');
    });

    it('indentation drift falls back to tier 3 and re-indents the replacement', async () => {
      const file = 'function f() {\n    if (cond) {\n        doThing();\n    }\n}\n';
      await fs.writeFile(path.join(sb.dir, 'a.ts'), file);
      await readTool.execute({ path: 'a.ts' }, sb.ctx, { signal: newSignal() });
      const out = await editTool.execute(
        {
          path: 'a.ts',
          // Model reproduced the block one indent level too shallow.
          old_string: 'if (cond) {\n    doThing();\n}',
          new_string: 'if (cond) {\n    doOther();\n}',
        },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.matched_by).toBe('whitespace-normalized');
      expect(out.note).toMatch(/re-indented/);
      const content = await fs.readFile(path.join(sb.dir, 'a.ts'), 'utf8');
      expect(content).toBe('function f() {\n    if (cond) {\n        doOther();\n    }\n}\n');
    });

    it('block-anchor fuzzy match repairs a slightly-wrong interior line', async () => {
      const file =
        'export function greet(name) {\n' +
        "  const message = 'hello there, ' + name;\n" +
        '  return message.toUpperCase();\n' +
        '}\n';
      await fs.writeFile(path.join(sb.dir, 'a.js'), file);
      await readTool.execute({ path: 'a.js' }, sb.ctx, { signal: newSignal() });
      const out = await editTool.execute(
        {
          path: 'a.js',
          // Interior line hallucinated: "hello there," became "hello  there,".
          old_string:
            'export function greet(name) {\n' +
            "  const message = 'hello  there, ' + name;\n" +
            '  return message.toUpperCase();\n' +
            '}',
          new_string:
            'export function greet(name) {\n' +
            "  const message = 'hi, ' + name;\n" +
            '  return message.toUpperCase();\n' +
            '}',
        },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.matched_by).toBe('fuzzy');
      expect(out.note).toMatch(/confidence: low/);
      expect(out.note).toMatch(/similarity/);
      const content = await fs.readFile(path.join(sb.dir, 'a.js'), 'utf8');
      expect(content).toContain("'hi, ' + name");
    });

    it('fuzzy match with two indistinguishable candidates is rejected', async () => {
      const block = 'function a() {\n  return compute(1, 2, 3);\n}\n';
      await fs.writeFile(path.join(sb.dir, 'a.js'), block + '\n' + block);
      await readTool.execute({ path: 'a.js' }, sb.ctx, { signal: newSignal() });
      await expect(
        editTool.execute(
          {
            path: 'a.js',
            // Interior differs slightly from BOTH copies → equal scores.
            old_string: 'function a() {\n  return compute(1, 2, 4);\n}',
            new_string: 'function a() {\n  return 0;\n}',
          },
          sb.ctx,
          { signal: newSignal() },
        ),
      ).rejects.toThrow(/scored too close/);
    });

    it('replace_all is refused for indent-insensitive fallback matches', async () => {
      await fs.writeFile(
        path.join(sb.dir, 'a.ts'),
        'function g() {\n    doThing(alpha, beta);\n    done();\n}\n',
      );
      await readTool.execute({ path: 'a.ts' }, sb.ctx, { signal: newSignal() });
      await expect(
        editTool.execute(
          {
            path: 'a.ts',
            // Two-line needle at the wrong indent level: not a substring, so
            // it can only match via the indent-insensitive tier.
            old_string: 'doThing(alpha, beta);\ndone();',
            new_string: 'doOther(alpha, beta);\ndone();',
            replace_all: true,
          },
          sb.ctx,
          { signal: newSignal() },
        ),
      ).rejects.toThrow(/replace_all requires an exact/);
    });

    it('replace_all works at the trailing-whitespace tier', async () => {
      await fs.writeFile(path.join(sb.dir, 'a.txt'), 'foo bar\nkeep\nfoo bar\n');
      await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
      const out = await editTool.execute(
        { path: 'a.txt', old_string: 'foo bar   ', new_string: 'baz', replace_all: true },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.matched_by).toBe('trailing-whitespace');
      expect(out.replacements).toBe(2);
      const content = await fs.readFile(path.join(sb.dir, 'a.txt'), 'utf8');
      expect(content).toBe('baz\nkeep\nbaz\n');
    });

    it('ambiguous tier-2 match without replace_all reports lines and tier', async () => {
      await fs.writeFile(path.join(sb.dir, 'a.txt'), 'same line\nother\nsame line\n');
      await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
      await expect(
        editTool.execute({ path: 'a.txt', old_string: 'same line  ', new_string: 'x' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/matched 2 times .*lines: 1, 3.*whitespace/s);
    });

    it('too-short needles never fall through to indent-insensitive tiers', async () => {
      await fs.writeFile(path.join(sb.dir, 'a.ts'), 'if (x) {\n  y();\n}\n');
      await readTool.execute({ path: 'a.ts' }, sb.ctx, { signal: newSignal() });
      await expect(
        // "  }" would trim-match the closing brace — must NOT be allowed.
        editTool.execute({ path: 'a.ts', old_string: '  }', new_string: '  };' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/no match/);
    });

    it('no-match error includes a snippet of the nearest candidate', async () => {
      await fs.writeFile(
        path.join(sb.dir, 'a.ts'),
        'const alpha = computeValue(input, options);\n',
      );
      await readTool.execute({ path: 'a.ts' }, sb.ctx, { signal: newSignal() });
      await expect(
        editTool.execute(
          {
            path: 'a.ts',
            old_string: 'const alpha = computeValue(input, settings);',
            new_string: 'x',
          },
          sb.ctx,
          { signal: newSignal() },
        ),
      ).rejects.toThrow(/Nearest match near line 1:[\s\S]*computeValue\(input, options\)/);
    });
  });

  describe('post-edit syntax check', () => {
    it('reports parse errors introduced by the edit on a .ts file', async () => {
      await fs.writeFile(path.join(sb.dir, 'a.ts'), 'const x = 1;\n');
      await readTool.execute({ path: 'a.ts' }, sb.ctx, { signal: newSignal() });
      const out = await editTool.execute(
        { path: 'a.ts', old_string: 'const x = 1;', new_string: 'const x = ;' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.syntax_errors).toBeDefined();
      expect(out.syntax_errors?.length).toBeGreaterThan(0);
      expect(out.note).toMatch(/introduced .* parse error/);
      // The edit is still applied — feedback, not rollback.
      expect(await fs.readFile(path.join(sb.dir, 'a.ts'), 'utf8')).toBe('const x = ;\n');
    });

    it('clean edits carry no syntax_errors', async () => {
      await fs.writeFile(path.join(sb.dir, 'a.ts'), 'const x = 1;\n');
      await readTool.execute({ path: 'a.ts' }, sb.ctx, { signal: newSignal() });
      const out = await editTool.execute(
        { path: 'a.ts', old_string: 'const x = 1;', new_string: 'const x = 2;' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.syntax_errors).toBeUndefined();
    });

    it('flags pre-existing parse errors as pre-existing', async () => {
      await fs.writeFile(path.join(sb.dir, 'a.ts'), 'const broken = ;\nconst y = 1;\n');
      await readTool.execute({ path: 'a.ts' }, sb.ctx, { signal: newSignal() });
      const out = await editTool.execute(
        { path: 'a.ts', old_string: 'const y = 1;', new_string: 'const y = 2;' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.syntax_errors).toBeDefined();
      expect(out.note).toMatch(/pre-date/);
    });

    it('non-code files are not syntax-checked', async () => {
      await fs.writeFile(path.join(sb.dir, 'a.txt'), 'not { valid json or ts\n');
      await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
      const out = await editTool.execute(
        { path: 'a.txt', old_string: 'valid', new_string: 'VALID' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.syntax_errors).toBeUndefined();
    });
  });
});

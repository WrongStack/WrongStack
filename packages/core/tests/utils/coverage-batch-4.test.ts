import { describe, it, expect } from 'vitest';
import { slugify } from '../../src/utils/slug.js';
import { assertNever } from '../../src/utils/assert-never.js';
import { stripAnsi } from '../../src/utils/color.js';
import { sleep } from '../../src/utils/sleep.js';
import { truncate } from '../../src/utils/string.js';
import {
  escapeGlobSubject,
  normalizePathSubject,
  isPathSubjectKey,
  subjectForToolInput,
} from '../../src/utils/tool-subject.js';
import {
  isJsonObject,
  getJsonPath,
  setJsonPath,
  removeJsonPath,
} from '../../src/utils/config-json.js';
import { sessionScopedPath } from '../../src/utils/session-scoped-path.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { writeJsonObjectFile, readJsonObjectFile } from '../../src/utils/config-json.js';

// ── slugify ─────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('produces a lowercase slug from a simple name', () => {
    expect(slugify('My Prompt')).toBe('my-prompt');
  });
  it('collapses runs of non-alphanumeric', () => {
    expect(slugify('Hello!!!  World___')).toBe('hello-world');
  });
  it('trims leading/trailing hyphens', () => {
    expect(slugify('---test---')).toBe('test');
  });
  it('caps at maxLen', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long, 'fb', 10)).toHaveLength(10);
  });
  it('returns fallback when input slugifies to empty', () => {
    expect(slugify('!!!')).toBe('prompt');
    expect(slugify('!!!', 'custom')).toBe('custom');
  });
});

// ── assertNever ──────────────────────────────────────────────────────────

describe('assertNever', () => {
  it('throws with default message', () => {
    expect(() => assertNever('x' as never)).toThrow('Unhandled case: "x"');
  });
  it('throws with custom message', () => {
    expect(() => assertNever('y' as never, 'custom error')).toThrow('custom error');
  });
  it('sets error name to AssertNeverError', () => {
    try {
      assertNever('z' as never);
    } catch (e) {
      expect((e as Error).name).toBe('AssertNeverError');
    }
  });
});

// ── stripAnsi ────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes ANSI escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m')).toBe('red');
  });
  it('leaves plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
  it('handles multiple sequences', () => {
    expect(stripAnsi('\x1b[1m\x1b[31mbold red\x1b[39m\x1b[22m')).toBe('bold red');
  });
  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

// ── truncate ─────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
  it('truncates with ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
  });
  it('returns exact-fit unchanged', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });
});

// ── sleep ────────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
  it('resolves for 0ms', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

// ── tool-subject ─────────────────────────────────────────────────────────

describe('tool-subject utilities', () => {
  it('escapeGlobSubject escapes metacharacters', () => {
    expect(escapeGlobSubject('file[0].ts')).toBe('file\\[0\\].ts');
    expect(escapeGlobSubject('a*b?c[d]')).toBe('a\\*b\\?c\\[d\\]');
  });
  it('normalizePathSubject replaces backslashes and escapes', () => {
    expect(normalizePathSubject('src\\components\\App.tsx')).toBe('src/components/App.tsx');
  });
  it('isPathSubjectKey checks path-like keys', () => {
    expect(isPathSubjectKey('path')).toBe(true);
    expect(isPathSubjectKey('file')).toBe(true);
    expect(isPathSubjectKey('files')).toBe(true);
    expect(isPathSubjectKey('url')).toBe(false);
  });
  it('subjectForToolInput uses subjectKey when provided', () => {
    expect(subjectForToolInput('read', { path: '/a/b.ts' }, 'path')).toBe('/a/b.ts');
    expect(subjectForToolInput('read', { command: 'ls' }, 'command')).toBe('ls');
  });
  it('subjectForToolInput infers from tool name (bash)', () => {
    expect(subjectForToolInput('bash', { command: 'git status' })).toBe('git status');
  });
  it('subjectForToolInput infers from common keys', () => {
    expect(subjectForToolInput('read', { path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(subjectForToolInput('fetch', { url: 'https://x.com' })).toBe('https://x.com');
    expect(subjectForToolInput('install', { name: 'react' })).toBe('react');
  });
  it('subjectForToolInput returns undefined for non-object input', () => {
    expect(subjectForToolInput('bash', null)).toBeUndefined();
    expect(subjectForToolInput('bash', 'string')).toBeUndefined();
    expect(subjectForToolInput('bash', {})).toBeUndefined();
  });
  it('subjectForToolInput coerces non-string command args (regression: WS-046 dropped them)', () => {
    // Non-string args (numbers, booleans, nested objects) must be coerced to
    // strings via String(), not silently dropped from the rendered command line.
    expect(subjectForToolInput('exec', { command: 'node', args: [1, true] }, 'command')).toBe(
      'node 1 true',
    );
    expect(subjectForToolInput('exec', { command: 'echo', args: ['hi', 42] }, 'command')).toBe(
      'echo hi 42',
    );
    // Nested objects coerce to "[object Object]" (contains a space → quoted);
    // escapeGlobSubject then escapes the glob metacharacters ([ and ]).
    expect(
      subjectForToolInput('exec', { command: 'run', args: [{ nested: true }] }, 'command'),
    ).toBe('run "\\[object Object\\]"');
  });
  it('subjectForToolInput gives dry-run patches a distinct subject (regression: dry-run/real over-grant)', () => {
    // A dry-run patch and a real patch on the same directory must NOT share a
    // subject, or trusting the preview would authorize the actual application.
    expect(subjectForToolInput('patch', { directory: 'src', dry_run: true }, 'directory')).toBe(
      'src:dry-run',
    );
    expect(subjectForToolInput('patch', { directory: 'src', dry_run: false }, 'directory')).toBe(
      'src',
    );
    expect(subjectForToolInput('patch', { directory: 'src' }, 'directory')).toBe('src');
    // Glob metacharacters in the directory are still escaped before the suffix.
    expect(subjectForToolInput('patch', { directory: 'a[b]', dry_run: true }, 'directory')).toBe(
      'a\\[b\\]:dry-run',
    );
  });
  it('subjectForToolInput gives dry-run install / check-only format / dry-run replace distinct subjects (over-grant sweep)', () => {
    // install: a dry-run install must not share a subject with a real install.
    expect(subjectForToolInput('install', { packages: 'react', dry_run: true }, 'packages')).toBe(
      'react:dry-run',
    );
    expect(subjectForToolInput('install', { packages: 'react' }, 'packages')).toBe('react');
    // format: a check-only format must not share a subject with a writing format.
    expect(subjectForToolInput('format', { files: 'src', check: true }, 'files')).toBe('src:check');
    expect(subjectForToolInput('format', { files: 'src' }, 'files')).toBe('src');
    // replace: a dry-run replace (the default) must not share a subject with a real replace.
    expect(subjectForToolInput('replace', { files: 'src', dry_run: true }, 'files')).toBe(
      'src:dry-run',
    );
    expect(subjectForToolInput('replace', { files: 'src', dry_run: false }, 'files')).toBe('src');
  });
  it('subjectForToolInput gives dry-run git commit a distinct subject (over-grant)', () => {
    // A dry-run `git commit` must not share a subject with a real commit.
    expect(subjectForToolInput('git', { command: 'commit', dry_run: true }, 'command')).toBe(
      'commit:dry-run',
    );
    expect(subjectForToolInput('git', { command: 'commit', dry_run: false }, 'command')).toBe(
      'commit',
    );
    expect(subjectForToolInput('git', { command: 'commit' }, 'command')).toBe('commit');
    // Other git subcommands are unaffected by the dry-run special-case.
    expect(subjectForToolInput('git', { command: 'push' }, 'command')).toBe('push');
  });
  it('subjectForToolInput gives dry-run scaffold a distinct subject (over-grant)', () => {
    // A dry-run scaffold must not share a subject with a real scaffold.
    expect(
      subjectForToolInput(
        'scaffold',
        { template: 'npm-package', name: 'foo', dry_run: true },
        'name',
      ),
    ).toBe('foo:dry-run');
    expect(
      subjectForToolInput(
        'scaffold',
        { template: 'npm-package', name: 'foo', dry_run: false },
        'name',
      ),
    ).toBe('foo');
    expect(subjectForToolInput('scaffold', { template: 'npm-package', name: 'foo' }, 'name')).toBe(
      'foo',
    );
  });
});

// ── config-json pure functions ──────────────────────────────────────────

describe('config-json pure functions', () => {
  it('isJsonObject distinguishes plain objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject('str')).toBe(false);
    expect(isJsonObject(42)).toBe(false);
  });
  it('getJsonPath traverses nested objects', () => {
    const root = { a: { b: { c: 42 } } };
    expect(getJsonPath(root, ['a', 'b', 'c'])).toBe(42);
  });
  it('getJsonPath returns undefined for missing path', () => {
    expect(getJsonPath({ a: 1 }, ['b'])).toBeUndefined();
  });
  it('getJsonPath traverses array indices', () => {
    expect(getJsonPath({ arr: [10, 20, 30] }, ['arr', 1])).toBe(20);
  });
  it('setJsonPath sets a nested value', () => {
    const root: Record<string, unknown> = { a: { b: 1 } };
    setJsonPath(root, ['a', 'c'], 2);
    expect((root.a as Record<string, unknown>).c).toBe(2);
  });
  it('setJsonPath creates intermediate objects', () => {
    const root: Record<string, unknown> = {};
    setJsonPath(root, ['x', 'y'], 'val');
    expect((root.x as Record<string, unknown>).y).toBe('val');
  });
  it('setJsonPath returns root', () => {
    const root: Record<string, unknown> = {};
    const result = setJsonPath(root, ['key'], 42);
    expect(result).toBe(root);
  });
  it('setJsonPath at root replaces with object', () => {
    const root: Record<string, unknown> = { old: true };
    const result = setJsonPath(root, [], { new: true });
    expect(result).toEqual({ new: true });
  });
  it('setJsonPath at root throws for non-object', () => {
    expect(() => setJsonPath({}, [], 'not-object')).toThrow('must be an object');
  });
  it('removeJsonPath deletes a key', () => {
    const root: Record<string, unknown> = { a: { b: 1, c: 2 } };
    expect(removeJsonPath(root, ['a', 'b'])).toBe(true);
    expect((root.a as Record<string, unknown>).b).toBeUndefined();
    expect((root.a as Record<string, unknown>).c).toBe(2);
  });
  it('removeJsonPath returns false for missing key', () => {
    expect(removeJsonPath({ a: 1 }, ['b'])).toBe(false);
  });
  it('removeJsonPath returns false for empty path', () => {
    expect(removeJsonPath({}, [])).toBe(false);
  });
});

// ── config-json file I/O ────────────────────────────────────────────────

describe('config-json file I/O', () => {
  it('round-trips write then read', async () => {
    const tmp = path.join(
      os.tmpdir(),
      `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    await writeJsonObjectFile(tmp, { hello: 'world', num: 42 });
    const read = await readJsonObjectFile(tmp);
    expect(read).toEqual({ hello: 'world', num: 42 });
    fs.unlinkSync(tmp);
  });
  it('readJsonObjectFile returns empty for missing file', async () => {
    const read = await readJsonObjectFile(path.join(os.tmpdir(), 'nonexistent-' + Date.now()));
    expect(read).toEqual({});
  });
  it('readJsonObjectFile returns empty for non-object JSON', async () => {
    const tmp = path.join(
      os.tmpdir(),
      `cfg2-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    fs.writeFileSync(tmp, '[1,2,3]');
    const read = await readJsonObjectFile(tmp);
    expect(read).toEqual({});
    fs.unlinkSync(tmp);
  });
});

// ── session-scoped-path ─────────────────────────────────────────────────

describe('sessionScopedPath', () => {
  const dir = os.tmpdir();
  it('resolves a simple session path', () => {
    const result = sessionScopedPath(dir, 'sess_abc', '.json');
    expect(result).toBe(path.resolve(dir, 'sess_abc.json'));
  });
  it('allows date-sharded session ids', () => {
    const result = sessionScopedPath(dir, '2026-06-11/sess_abc', '.json');
    expect(result).toBe(path.resolve(dir, '2026-06-11', 'sess_abc.json'));
  });
  it('rejects empty session id', () => {
    expect(() => sessionScopedPath(dir, '', '.json')).toThrow('Invalid sessionId');
  });
  it('rejects backslashes', () => {
    expect(() => sessionScopedPath(dir, 'sess\\evil', '.json')).toThrow('Invalid sessionId');
  });
  it('rejects .. traversal', () => {
    expect(() => sessionScopedPath(dir, '../etc/passwd', '')).toThrow('Invalid sessionId');
  });
  it('rejects absolute path escape', () => {
    expect(() => sessionScopedPath(dir, '/etc/passwd', '')).toThrow('Invalid sessionId');
  });
});

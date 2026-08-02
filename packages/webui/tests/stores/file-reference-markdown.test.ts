import { beforeEach, describe, expect, it } from 'vitest';
import {
  type FileReference,
  refLabel,
  refsToMarkdown,
  useFileReferenceStore,
} from '../../src/stores/file-reference-store';

function fileRef(path: string): FileReference {
  return { id: `f-${path}`, kind: 'file', path };
}

function rangeRef(path: string, preview = 'const a = 1;'): FileReference {
  return { id: 'r1', kind: 'range', path, startLine: 10, endLine: 12, preview };
}

function snippetRef(path: string, content = 'const b = 2;'): FileReference {
  return { id: 's1', kind: 'snippet', path, startLine: 3, endLine: 4, content };
}

describe('refsToMarkdown', () => {
  it('returns an empty string for no refs', () => {
    expect(refsToMarkdown([])).toBe('');
  });

  it('renders a mention plus a complete-read contract when no content is available', () => {
    const out = refsToMarkdown([fileRef('src/a.ts')]);
    expect(out).toContain('@src/a.ts');
    expect(out).toContain('read each complete project file');
    expect(out).toContain('- "src/a.ts"');
    expect(out).toContain('until EOF');
  });

  it('inlines whole-file content as a fenced block so the LLM skips a read', () => {
    const out = refsToMarkdown([fileRef('src/a.ts')], { 'src/a.ts': 'const a = 1;' });
    expect(out).toBe('```typescript\n// src/a.ts (entire file)\nconst a = 1;\n```');
  });

  it('falls back to a mention when the map has no entry for that path', () => {
    const out = refsToMarkdown([fileRef('src/a.ts')], { 'src/b.ts': 'x' });
    expect(out).toContain('@src/a.ts');
    expect(out).toContain('- "src/a.ts"');
  });

  it('falls back to a mention for empty file content', () => {
    const out = refsToMarkdown([fileRef('src/a.ts')], { 'src/a.ts': '' });
    expect(out).toContain('@src/a.ts');
    expect(out).toContain('- "src/a.ts"');
  });

  it('renders a range ref with a line header', () => {
    expect(refsToMarkdown([rangeRef('src/a.ts')])).toBe(
      '```typescript\n// src/a.ts:10-12\nconst a = 1;\n```',
    );
  });

  it('renders a snippet ref from its content field', () => {
    expect(refsToMarkdown([snippetRef('src/a.ts')])).toBe(
      '```typescript\n// src/a.ts:3-4\nconst b = 2;\n```',
    );
  });

  it('separates multiple refs with a blank line', () => {
    const out = refsToMarkdown([fileRef('a.ts'), fileRef('b.ts')]);
    expect(out).toContain('@a.ts\n\n@b.ts');
    expect(out).toContain('- "a.ts"\n- "b.ts"');
  });

  it('mixes mention and fenced forms in one payload', () => {
    const out = refsToMarkdown([fileRef('a.ts'), rangeRef('b.py')], { 'a.ts': 'x' });
    expect(out).toContain('// a.ts (entire file)');
    expect(out).toContain('```python');
  });

  // ── language detection ────────────────────────────────────────────────────

  it.each([
    ['a.ts', 'typescript'],
    ['a.tsx', 'typescript'],
    ['a.js', 'javascript'],
    ['a.jsx', 'javascript'],
    ['a.json', 'json'],
    ['a.md', 'markdown'],
    ['a.mdx', 'markdown'],
    ['a.css', 'css'],
    ['a.scss', 'scss'],
    ['a.html', 'html'],
    ['a.htm', 'html'],
    ['a.py', 'python'],
    ['a.rs', 'rust'],
    ['a.go', 'go'],
    ['a.rb', 'ruby'],
    ['a.java', 'java'],
    ['a.c', 'c'],
    ['a.h', 'c'],
    ['a.cpp', 'cpp'],
    ['a.hpp', 'cpp'],
    ['a.sh', 'bash'],
    ['a.bash', 'bash'],
    ['a.sql', 'sql'],
    ['a.yaml', 'yaml'],
    ['a.yml', 'yaml'],
    ['a.toml', 'toml'],
  ])('tags %s as %s', (path, lang) => {
    expect(refsToMarkdown([rangeRef(path)])).toContain(`\`\`\`${lang}`);
  });

  it('emits an untagged fence for an unknown extension', () => {
    expect(refsToMarkdown([rangeRef('a.xyz')]).split('\n')[0]).toBe('```');
  });

  it('emits an untagged fence for a file with no extension', () => {
    expect(refsToMarkdown([rangeRef('Makefile')]).split('\n')[0]).toBe('```');
  });

  it('is case-insensitive about the extension', () => {
    expect(refsToMarkdown([rangeRef('A.TS')])).toContain('```typescript');
  });

  // ── truncation ────────────────────────────────────────────────────────────

  it('truncates content beyond 20 lines and marks the cut', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const out = refsToMarkdown([snippetRef('a.ts', long)]);
    expect(out).toContain('line 19');
    expect(out).not.toContain('line 20');
    expect(out).toContain('…');
  });

  it('keeps content at exactly 20 lines intact', () => {
    const exact = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const out = refsToMarkdown([snippetRef('a.ts', exact)]);
    expect(out).toContain('line 19');
    expect(out).not.toContain('…');
  });

  it('truncates content beyond 2000 characters', () => {
    const wide = 'x'.repeat(3000);
    const out = refsToMarkdown([snippetRef('a.ts', wide)]);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(3000);
  });

  it('trims trailing whitespace before the ellipsis', () => {
    const long = `${Array.from({ length: 25 }, () => 'a').join('\n')}   `;
    const out = refsToMarkdown([snippetRef('a.ts', long)]);
    expect(out).not.toContain(' \n…');
  });

  it('truncates inlined whole-file content too', () => {
    const long = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    const out = refsToMarkdown([fileRef('a.ts')], { 'a.ts': long });
    expect(out).toContain('…');
    expect(out).toContain('// a.ts (preview; complete read required)');
    expect(out).toContain('- "a.ts"');
    expect(out).toContain('until EOF');
  });
});

describe('refLabel', () => {
  it('shows just the basename for a whole-file ref', () => {
    expect(refLabel(fileRef('packages/webui/src/a.ts'))).toBe('a.ts');
  });

  it('appends the line range for a range ref', () => {
    expect(refLabel(rangeRef('packages/webui/src/a.ts'))).toBe('a.ts:10-12');
  });

  it('appends the line range for a snippet ref', () => {
    expect(refLabel(snippetRef('src/a.ts'))).toBe('a.ts:3-4');
  });

  it('handles Windows separators', () => {
    expect(refLabel(fileRef('D:\\code\\app\\a.ts'))).toBe('a.ts');
  });

  it('returns the whole string when there is no separator', () => {
    expect(refLabel(fileRef('a.ts'))).toBe('a.ts');
  });
});

describe('file reference store', () => {
  beforeEach(() => {
    useFileReferenceStore.setState({ refs: [] });
  });

  it('adds a ref with a generated id', () => {
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'a.ts' });
    const refs = useFileReferenceStore.getState().refs;
    expect(refs).toHaveLength(1);
    expect(refs[0]?.id).toBeTruthy();
  });

  it('de-duplicates whole-file refs by path', () => {
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'a.ts' });
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'a.ts' });
    expect(useFileReferenceStore.getState().refs).toHaveLength(1);
  });

  it('allows distinct file paths', () => {
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'a.ts' });
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'b.ts' });
    expect(useFileReferenceStore.getState().refs).toHaveLength(2);
  });

  it('does not de-duplicate range refs — two ranges in one file are distinct', () => {
    const base = { kind: 'range' as const, path: 'a.ts', preview: 'x' };
    useFileReferenceStore.getState().addRef({ ...base, startLine: 1, endLine: 2 });
    useFileReferenceStore.getState().addRef({ ...base, startLine: 9, endLine: 10 });
    expect(useFileReferenceStore.getState().refs).toHaveLength(2);
  });

  it('gives every ref a unique id', () => {
    for (let i = 0; i < 5; i++) {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: `f${i}.ts` });
    }
    const ids = useFileReferenceStore.getState().refs.map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('removes a ref by id', () => {
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'a.ts' });
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'b.ts' });
    const target = useFileReferenceStore.getState().refs[0]!.id;
    useFileReferenceStore.getState().removeRef(target);
    expect(useFileReferenceStore.getState().refs.map((r) => r.path)).toEqual(['b.ts']);
  });

  it('removeRef is a no-op for an unknown id', () => {
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'a.ts' });
    useFileReferenceStore.getState().removeRef('nope');
    expect(useFileReferenceStore.getState().refs).toHaveLength(1);
  });

  it('clearRefs empties the list', () => {
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'a.ts' });
    useFileReferenceStore.getState().clearRefs();
    expect(useFileReferenceStore.getState().refs).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { detectLang, highlightLine, type HLState, type Lang } from '../src/highlight.js';
import { softColor } from '../src/theme.js';

const CORPUS: Record<Lang, string[]> = {
  ts: [
    "const x = 'hi'; // comment",
    'export function foo(a: number): boolean { return a > 0 }',
    `let s = \`template \${x}\` /* block */ + 1.5e3`,
    'interface T { name: string; readonly id: number }',
    '',
  ],
  js: ['var y = "str"; const z = 0xFF // hex', 'async function g() { await h() }'],
  json: ['{ "name": "wrongstack", "version": 10, "ok": true, "x": null }', '  "key": [1, 2, 3],'],
  bash: [
    'ls -la --color $HOME # list',
    `echo "\${VAR}" | grep -i foo`,
    'if [ -f x ]; then cd /tmp; fi',
  ],
  python: [
    'def f(x): return x + 1  # comment',
    '@decorator',
    "s = 'hello' + str(3)",
    'import os as o',
  ],
  diff: ['@@ -1,2 +1,3 @@', '+added line', '-removed line', ' context', '--- a/file'],
  plain: ['just some text', 'no language here', ''],
};

describe('highlightLine — length-preserving invariant (critical for Ink width)', () => {
  for (const lang of Object.keys(CORPUS) as Lang[]) {
    for (const line of CORPUS[lang]) {
      it(`[${lang}] tokens join back to the exact input: ${JSON.stringify(line)}`, () => {
        const { tokens } = highlightLine(line, lang);
        expect(tokens.map((t) => t.text).join('')).toBe(line);
      });
    }
  }
});

describe('highlightLine — multi-line carry', () => {
  it('keeps a ts block comment open across lines', () => {
    const r1 = highlightLine('foo(); /* start', 'ts');
    expect(r1.carry.block).toBe(true);
    const r2 = highlightLine('still comment', 'ts', r1.carry);
    expect(r2.tokens.every((t) => t.color === 'syntax.comment')).toBe(true);
    expect(r2.tokens.map((t) => t.text).join('')).toBe('still comment');
    const r3 = highlightLine('end */ done', 'ts', r2.carry);
    expect(r3.carry.block).toBe(false);
    expect(r3.tokens.map((t) => t.text).join('')).toBe('end */ done');
  });

  it('keeps a python triple string open across lines', () => {
    const r1 = highlightLine('s = """start', 'python');
    expect(r1.carry.triple).toBe('"""');
    const r2 = highlightLine('mid', 'python', r1.carry);
    expect(r2.tokens.map((t) => t.text).join('')).toBe('mid');
    const r3 = highlightLine('end"""', 'python', r2.carry);
    expect(r3.carry.triple).toBeFalsy();
  });
});

describe('highlightLine — coloring sanity', () => {
  // The tokenizer emits SEMANTIC ROLE names, never literal colors — that is
  // what lets `/theme` reach syntax highlighting. `softColor` resolves them
  // against the active palette at render time; `theme-presets.test.ts` proves
  // every role resolves to a real hex for all 35 presets.
  it('colors ts keywords and strings', () => {
    const { tokens } = highlightLine("const a = 'x'", 'ts');
    expect(tokens.find((t) => t.text === 'const')?.color).toBe('syntax.keyword');
    expect(tokens.find((t) => t.text === "'x'")?.color).toBe('syntax.string');
  });
  it('colors json keys vs string values distinctly', () => {
    const { tokens } = highlightLine('{ "k": "v" }', 'json');
    expect(tokens.find((t) => t.text === '"k"')?.color).toBe('syntax.property');
    expect(tokens.find((t) => t.text === '"v"')?.color).toBe('syntax.string');
  });
  it('classifies diff lines', () => {
    expect(highlightLine('+x', 'diff').tokens[0]?.color).toBe('syntax.diffAdd');
    expect(highlightLine('-x', 'diff').tokens[0]?.color).toBe('syntax.diffDel');
    expect(highlightLine('@@ x @@', 'diff').tokens[0]?.color).toBe('syntax.diffMeta');
  });

  it('never emits a literal color — every color is a resolvable syntax role', () => {
    // An unresolvable name reaches chalk, which drops it SILENTLY: the token
    // renders with no color at all. This is exactly how `grayBright` hid for
    // so long, so pin the invariant at the source.
    const samples: [string, Parameters<typeof highlightLine>[1]][] = [
      ["const a = 'x' // c", 'ts'],
      ['{ "k": 1, "b": true }', 'json'],
      ['ls --all $HOME # c', 'bash'],
      ['@dec\ndef f(): pass  # c', 'python'],
      ['+added', 'diff'],
      ['-removed', 'diff'],
      ['@@ -1 +1 @@', 'diff'],
    ];
    for (const [line, lang] of samples) {
      for (const t of highlightLine(line, lang).tokens) {
        if (t.color === undefined) continue;
        expect(t.color, `${lang}: ${line}`).toMatch(/^syntax\.[a-zA-Z]+$/);
        expect(softColor(t.color), `${lang}: ${t.color}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe('detectLang', () => {
  it('maps fence aliases to supported languages', () => {
    expect(detectLang('ts')).toBe('ts');
    expect(detectLang('tsx')).toBe('ts');
    expect(detectLang('typescript')).toBe('ts');
    expect(detectLang('sh')).toBe('bash');
    expect(detectLang('py')).toBe('python');
    expect(detectLang('json')).toBe('json');
    expect(detectLang('rust')).toBe('plain');
    expect(detectLang('')).toBe('plain');
    expect(detectLang('ts {2,4}')).toBe('ts'); // first token only
  });
});

// Fuzz-ish: random ASCII lines must always round-trip for every language.
describe('highlightLine — never drops/adds glyphs (fuzz)', () => {
  const samples = [
    `\`\\\\a\` "x\\"y" /*/ #@$%^&*()`,
    "'''not''' python? @x #y",
    `$VAR \${X} --flag -f "q'q" \`tick\``,
    '\t  mixed   ws\t\tend',
  ];
  const langs: Lang[] = ['ts', 'js', 'json', 'bash', 'python', 'diff', 'plain'];
  for (const lang of langs) {
    for (const s of samples) {
      it(`[${lang}] round-trips ${JSON.stringify(s)}`, () => {
        let carry: HLState = {};
        const r = highlightLine(s, lang, carry);
        carry = r.carry;
        expect(r.tokens.map((t) => t.text).join('')).toBe(s);
      });
    }
  }
});

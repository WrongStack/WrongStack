import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
  autoFenceCode,
  unfenceCode,
} from '../../../src/components/ChatInput/code-detect';

describe('detectLanguage', () => {
  it('returns null for empty string', () => expect(detectLanguage('')).toBeNull());
  it('returns null for 1 line', () => expect(detectLanguage('x = 1')).toBeNull());
  it('returns null for 2 lines', () =>
    expect(detectLanguage('def hello():\n    print("world")')).toBeNull());
  it('returns null for 3 lines of pure prose', () => {
    expect(
      detectLanguage('This is a paragraph.\nIt looks like prose.\nMore text here.'),
    ).toBeNull();
  });
  it('returns null when codeIndicators < 2', () => {
    // Only 1 line has indentation → codeIndicators=1, below threshold
    expect(detectLanguage('def hello():\nprint("world")\nx = 1')).toBeNull();
  });
  it('returns null for short python-like code (below threshold)', () => {
    // 4 lines but only 1 codeIndicator line
    expect(detectLanguage('def hello():\nprint("world")\nx = 1')).toBeNull();
  });

  // TypeScript — strong type annotation patterns
  it('detects typescript from type annotations', () => {
    expect(
      detectLanguage(
        'const x: string = "hello";\nconst y: number = 42;\nconst fn = (): void => {};\nexport { x };',
      ),
    ).toBe('typescript');
  });
  it('detects typescript from interface', () => {
    expect(detectLanguage('interface User {\n  name: string;\n  age: number;\n}')).toBe(
      'typescript',
    );
  });
  it('detects typescript from import/export + type annotation', () => {
    expect(
      detectLanguage(
        'import { useState } from "react";\nexport const x: number = 1;\nconst y: string = "hi";\nconst z = 1;',
      ),
    ).toBe('typescript');
  });
  it('prefers typescript over javascript when both score', () => {
    expect(
      detectLanguage(
        'import { x } from "y";\nconst y: string = "hi";\nexport const z = 1;\nconst a = 1;',
      ),
    ).toBe('typescript');
  });
  it('detects typescript from const assignments (no strong TS pattern but enough indicators)', () => {
    // Basic const assignments trigger typescript detection
    expect(detectLanguage('const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;')).toBe(
      'typescript',
    );
  });

  // JSON — very strong pattern
  it('detects json', () => {
    expect(detectLanguage('{\n  "name": "test",\n  "value": 42\n}')).toBe('json');
  });
  it('returns null for incomplete json (3 lines)', () => {
    expect(detectLanguage('{\n  "name": "test",')).toBeNull();
  });

  // HTML — strong opening tag patterns
  it('detects html from doctype', () => {
    expect(detectLanguage('<!DOCTYPE html>\n<html>\n<body>\n  <div>Hello</div>')).toBe('html');
  });
  it('detects html from div/span tags', () => {
    expect(detectLanguage('<div class="container">\n  <span id="x">text</span>\n</div>')).toBe(
      'html',
    );
  });
  it('detects html from a/p tags', () => {
    expect(
      detectLanguage('<a href="/home">Home</a>\n<p>Paragraph</p>\n<ul><li>Item</li></ul>'),
    ).toBe('html');
  });

  // Rust — strong patterns
  it('detects rust from let mut', () => {
    expect(detectLanguage('let mut counter = 0;\ncounter += 1;\nfn init() {}\nlet y = 1;')).toBe(
      'rust',
    );
  });
  it('detects rust from struct/enum/impl', () => {
    expect(
      detectLanguage(
        'struct Point { x: i32, y: i32 }\nimpl Point {\n    fn new(x: i32) -> Self { Point { x } }\n}\nlet z = 1;',
      ),
    ).toBe('rust');
  });
  it('detects rust with ::new pattern', () => {
    expect(detectLanguage('impl Builder {\n    pub fn new() -> Self { Self }\n}\nlet x = 1;')).toBe(
      'rust',
    );
  });

  // Go — strong patterns
  it('detects go from package + func', () => {
    expect(detectLanguage('package main\n\nfunc main() {}\nfunc init() {}\nlet x = 1;')).toBe('go');
  });
  it('detects go from defer keyword', () => {
    expect(detectLanguage('func cleanup() { defer close() }\nfunc main() {}\nlet x = 1;')).toBe(
      'go',
    );
  });
  it('prefers go over rust when go score is higher', () => {
    expect(detectLanguage('func init() {}\nfunc main() {}\nlet x = 1;')).toBe('go');
  });
  it('prefers rust over go for struct/enum/impl', () => {
    expect(
      detectLanguage(
        'struct Point { x: i32, y: i32 }\nimpl Point {\n    fn new() -> Self { Point { x: 0 } }\n}',
      ),
    ).toBe('rust');
  });

  // CSS — strong patterns
  it('detects css from @media rules', () => {
    expect(
      detectLanguage('@media (min-width: 600px) {\n  .col { flex: 1; }\n}\n@import "reset.css";'),
    ).toBe('css');
  });
  it('detects css with px/rem/em units', () => {
    expect(detectLanguage('.box {\n  padding: 10px !important;\n  margin: 1rem 2em;\n}')).toBe(
      'css',
    );
  });

  // SQL — strong patterns
  it('detects sql from SELECT keyword', () => {
    expect(
      detectLanguage(
        'SELECT id, name FROM users WHERE active = 1;\nINSERT INTO logs VALUES (1);\nx = 1;',
      ),
    ).toBe('sql');
  });

  // Bash — strong patterns
  it('detects bash from shebang', () => {
    expect(detectLanguage('#!/bin/bash\necho "Hello world"\nx=1')).toBe('bash');
  });
  it('detects bash from export + if', () => {
    expect(
      detectLanguage('export PATH=/usr/bin:$PATH\nif [[ -z $x ]]; then\n  echo "empty"\nfi'),
    ).toBe('bash');
  });
});

describe('autoFenceCode', () => {
  it('returns null for prose', () => expect(autoFenceCode('just some prose text here')).toBeNull());
  it('returns null for empty string', () => expect(autoFenceCode('')).toBeNull());
  it('returns null for already fenced text', () =>
    expect(autoFenceCode('```typescript\nconst x = 1;\n```')).toBeNull());
  it('returns null when detectLanguage returns null', () => {
    expect(autoFenceCode('const x = 1;')).toBeNull();
  });

  it('fences and detects typescript', () => {
    const c = 'const x: string = "hello";\nconst y: number = 42;\nconst z = 1;\nexport { x };';
    const result = autoFenceCode(c);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('typescript');
    expect(result!.fenced).toContain('```typescript');
    expect(result!.fenced).toContain(c);
  });

  it('fences and detects html', () => {
    const c = '<!DOCTYPE html>\n<html>\n<body>\n  <div>Hello</div>';
    const result = autoFenceCode(c);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('html');
  });

  it('fences and detects json', () => {
    const c = '{\n  "key": "value"\n}';
    const result = autoFenceCode(c);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('json');
  });

  it('fences and detects css', () => {
    const c = '.box {\n  padding: 10px !important;\n  margin: 1rem 2em;\n}';
    const result = autoFenceCode(c);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('css');
  });

  it('fences and detects sql', () => {
    const c = 'SELECT id FROM users;\nINSERT INTO t VALUES(1);\nx = 1;';
    const result = autoFenceCode(c);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('sql');
  });

  it('fences and detects go', () => {
    const c = 'package main\n\nfunc main() { println("hi") }\nlet x = 1;';
    const result = autoFenceCode(c);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('go');
  });

  it('fences and detects bash from shebang', () => {
    const c = '#!/bin/bash\necho "hi"\nx=1';
    const result = autoFenceCode(c);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('bash');
  });

  it('fences and detects rust', () => {
    const c = 'impl Builder {\n    pub fn new() -> Self { Self }\n}\nlet x = 1;';
    const result = autoFenceCode(c);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('rust');
  });

  it('fenced output contains original text unchanged', () => {
    const original = 'const x: number = 42;\nconst y: string = "hi";';
    const result = autoFenceCode(original + '\nconst z = 1;');
    expect(result!.fenced).toContain(original);
  });
});

describe('unfenceCode', () => {
  it('returns null for non-fenced text', () => expect(unfenceCode('just some text')).toBeNull());
  it('returns null for partial fence (opening only)', () =>
    expect(unfenceCode('```\ncode\n')).toBeNull());
  it('returns null for partial fence (closing only)', () =>
    expect(unfenceCode('code\n```')).toBeNull());
  it('returns null for empty fence content', () => expect(unfenceCode('```\n```')).toBeNull());

  it('unfences code with language', () => {
    expect(unfenceCode('```typescript\nconst x = 1;\n```')).toBe('const x = 1;');
  });
  it('unfences code with empty language', () => {
    expect(unfenceCode('```\ncode here\n```')).toBe('code here');
  });
  it('unfences code with trailing whitespace', () => {
    expect(unfenceCode('```js\nconst x = 1;\n```  \n')).toBe('const x = 1;');
  });
  it('unfences code with leading whitespace in content', () => {
    expect(unfenceCode('```\n  indented code\n  more\n```')).toBe('  indented code\n  more');
  });
  it('handles multiline unfenced content', () => {
    const code = 'line one\nline two\nline three';
    expect(unfenceCode('```\n' + code + '\n```')).toBe(code);
  });
  it('handles code with backticks inside', () => {
    expect(unfenceCode('```\nconst x = `template`;\n```')).toBe('const x = `template`;');
  });
  it('handles code with nested backticks', () => {
    expect(unfenceCode('```\nconst x = `a` + `b`;\n```')).toBe('const x = `a` + `b`;');
  });
});

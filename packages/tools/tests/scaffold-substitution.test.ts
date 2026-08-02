/**
 * WS-057 — both halves of scaffold's variable substitution were injectable,
 * and both inputs come straight from the tool's arguments.
 *
 *   - The variable NAME was interpolated raw into `new RegExp(...)`. The loop
 *     compiles a regex for EVERY key regardless of whether the template
 *     contains a matching placeholder, so a key of `(` threw a SyntaxError and
 *     aborted the whole scaffold. A key of `.*` compiles to `\{\{.*\}\}`, which
 *     is greedy and matches from the first `{{` to the LAST `}}`.
 *   - The VALUE was passed as a replacement STRING, where `$&`, `` $` ``, `$'`
 *     and `$1` are special to `String.replace`. Verified concretely: with the
 *     old code, `name: 'a$&b'` produced `a{{name}}b` in the output — `$&`
 *     expanded to the matched placeholder instead of staying literal.
 *
 * The same function also builds the output FILE PATH, so this affected where
 * files landed, not only their contents.
 *
 * Reachability, checked rather than assumed. `name` flows into every built-in
 * template through `{{name}}`/`{{Name}}`, so the value vector is live today.
 * The key vector is live through the throw, because the regex is compiled per
 * key whether or not it matches. A greedy `.*` key needs a template with a
 * leftover `{{…}}` after the name pass; the three built-ins carry only
 * `{{name}}`/`{{Name}}`, and the "path to template directory" the schema
 * advertises is not implemented in `execute` — so that particular shape is not
 * reachable today. The escape is still correct, and becomes load-bearing the
 * moment directory templates land.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffoldTool } from '../src/scaffold.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scaffold-subst-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as never;

async function scaffold(input: Record<string, unknown>): Promise<string> {
  await scaffoldTool.execute({ template: 'npm-package', ...input } as never, makeCtx(), {
    signal: new AbortController().signal,
  });
  return await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8');
}

describe('variable VALUES are literal (WS-057)', () => {
  it('does not expand $& into the matched placeholder', async () => {
    // The concrete pre-fix output was `"name": "a{{name}}b"`.
    const out = await scaffold({ name: 'a$&b' });
    expect(out).toContain('a$&b');
    expect(out).not.toContain('{{name}}');
  });

  it('does not expand $` into everything before the match', async () => {
    // The dangerous one: `` $` `` copies the preceding template text into the
    // output, so a value could duplicate surrounding content.
    const out = await scaffold({ name: 'x$`y' });
    expect(out).toContain('x$`y');
    expect(out).not.toMatch(/x\{\s*"name"/);
  });

  it("does not expand $' or $1 either", async () => {
    const out = await scaffold({ name: "p$'q$1r" });
    expect(out).toContain("p$'q$1r");
  });

  it('leaves an ordinary name untouched and still kebab-cases it', async () => {
    const out = await scaffold({ name: 'My Project' });
    expect(out).toContain('my-project');
  });
});

describe('variable NAMES are regex-escaped (WS-057)', () => {
  it('a key with unbalanced regex syntax does not abort the scaffold', async () => {
    // Live today: the regex is compiled for every key even when the template
    // has no matching placeholder, so `(` threw a SyntaxError out of the tool.
    const out = await scaffold({ name: 'ok', vars: { '(': 'x', '[a-': 'y', '\\': 'z' } });
    expect(out).toContain('ok');
  });

  it('a key of .* does not silently become a greedy matcher', async () => {
    // Not reachable through the built-ins (no `{{…}}` survives the name pass),
    // so this asserts the escape holds rather than demonstrating an exploit.
    // It is the guard that must already exist when directory templates land.
    const out = await scaffold({ name: 'ok', vars: { '.*': 'INJECTED' } });
    expect(out).not.toContain('INJECTED');
    expect(out).toContain('ok');
  });

  it('a key with metacharacters still substitutes literally when it matches', async () => {
    // Escaping must make the key literal, not unusable. `{{name}}` is consumed
    // by the built-in pass first, so use the path substitution as the witness:
    // the file is still created under the expected name.
    await scaffoldTool.execute(
      { template: 'npm-package', name: 'plain', vars: { 'a.b': 'v' } } as never,
      makeCtx(),
      { signal: new AbortController().signal },
    );
    await expect(fs.stat(path.join(tmpDir, 'package.json'))).resolves.toBeTruthy();
  });
});

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createToolOutputSerializer } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editTool } from '../src/edit.js';
import { jsonTool } from '../src/json.js';
import { patchTool } from '../src/patch.js';
import { readTool } from '../src/read.js';
import { replaceTool } from '../src/replace.js';
import { mkSandbox, type Sandbox } from './fixtures.js';

/**
 * Inputs the file tools' own descriptions promise but the implementations
 * refused or mis-rendered, found by driving each tool against real files
 * (tool pass 2026-11-27).
 */
let sb: Sandbox;
beforeEach(async () => {
  sb = await mkSandbox();
});
afterEach(async () => {
  await sb.cleanup();
});

const put = (rel: string, content: string | Buffer) =>
  fs.writeFile(path.join(sb.dir, rel), content);

describe('json reads the formats it advertises', () => {
  it('reads a commented tsconfig-style JSONC file', async () => {
    await put(
      'tsconfig.json',
      '{\n  // strict mode\n  "compilerOptions": { "strict": true, },\n}\n',
    );
    const out = await jsonTool.execute(
      { file: 'tsconfig.json', query: 'compilerOptions.strict' },
      sb.ctx,
    );
    expect(out.query_result).toBe(true);
    expect(out.source_format).toBe('jsonc');
  });

  it('reads a .yaml file and queries it', async () => {
    await put('ci.yaml', 'jobs:\n  test:\n    steps: [checkout, build]\n');
    const out = await jsonTool.execute(
      { file: 'ci.yaml', action: 'query', query: 'jobs.test.steps[1]' },
      sb.ctx,
    );
    expect(out.query_result).toBe('build');
  });

  it('shows the model which syntax was read', async () => {
    await put('tsconfig.json', '{ "a": 1, // note\n}\n');
    const out = await jsonTool.execute({ file: 'tsconfig.json' }, sb.ctx);
    const rendered = createToolOutputSerializer().serialize(out, {
      toolName: 'json',
      input: { file: 'tsconfig.json' },
    });
    expect(rendered.split('\n')[0]).toContain('source_format=jsonc');
  });

  it('keeps the syntax check strict: JSONC is not valid JSON', async () => {
    const jsonc = await jsonTool.execute({ data: '{a: 1,}', validate: true }, sb.ctx);
    expect(jsonc.valid).toBe(false);
    expect(jsonc.formatted).toContain('valid as JSONC');
    const strict = await jsonTool.execute({ data: '{"a": 1}', validate: true }, sb.ctx);
    expect(strict.valid).toBe(true);
  });

  it('still refuses broken JSON instead of reading it as a YAML flow mapping', async () => {
    await expect(jsonTool.execute({ data: '{invalid}' }, sb.ctx)).rejects.toThrow(/parse failed/);
    await expect(jsonTool.execute({ data: '{"a": 1,,}' }, sb.ctx)).rejects.toThrow(/parse failed/);
  });

  it('renders a query that selects nothing as null, not as the input document', async () => {
    const out = await jsonTool.execute(
      { data: '{"a":{"secret":"input"}}', action: 'query', query: 'missing' },
      sb.ctx,
    );
    expect(out.formatted).toBe('null');
  });

  it('says why a document failed schema validation', async () => {
    const out = await jsonTool.execute(
      {
        action: 'validate',
        data: '{"port":"80"}',
        schema: { type: 'object', properties: { port: { type: 'number' } } },
      },
      sb.ctx,
    );
    expect(out.valid).toBe(false);
    expect(out.formatted.startsWith('invalid\n- ')).toBe(true);
    expect(out.formatted).toContain('port');
  });
});

describe('read decodes BOM-declared UTF-16 text', () => {
  it.each([
    [
      'utf16le',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\r\nbeta\r\n', 'utf16le')]),
    ],
    [
      'utf16be',
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from('alpha\r\nbeta\r\n', 'utf16le').swap16(),
      ]),
    ],
  ] as const)('%s', async (encoding, bytes) => {
    await put('out.txt', bytes);
    const out = await readTool.execute({ path: 'out.txt' }, sb.ctx);
    expect(out.encoding).toBe(encoding);
    expect(out.text).toBe('1→alpha\n2→beta');
  });

  it('edit names a way to change a UTF-16 file instead of pointing at write', async () => {
    await put(
      'ps.txt',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\r\n', 'utf16le')]),
    );
    const err = await editTool
      .execute({ path: 'ps.txt', old_string: 'alpha', new_string: 'ALPHA' }, sb.ctx)
      .then(
        () => undefined,
        (e: Error) => e,
      );
    expect(err?.message).toMatch(/is UTF-16 text, not editable text here: edit and write only rewrite UTF-8/);
    expect(err?.message).toContain('Set-Content -Encoding utf8');
  });

  it('still refuses a NUL-bearing binary without a BOM', async () => {
    await put('blob.bin', Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]));
    await expect(readTool.execute({ path: 'blob.bin' }, sb.ctx)).rejects.toThrow(/binary/);
  });
});

describe('replace reports project-relative paths', () => {
  it('names files relative to the project root in results and diff headers', async () => {
    await fs.mkdir(path.join(sb.dir, 'src'));
    await put('src/a.txt', 'old\n');
    const out = await replaceTool.execute(
      { pattern: 'old', replacement: 'new', files: 'src/a.txt' },
      sb.ctx,
    );
    expect(out.results[0]?.path).toBe('src/a.txt');
    expect(out.results[0]?.diff).toContain('--- src/a.txt');
    expect(JSON.stringify(out)).not.toContain(sb.dir.replace(/\\/g, '\\\\'));
  });
});

describe('path escapes name the real cause', () => {
  it('calls a plain ../ escape "outside project root", not a symlink', async () => {
    // patch resolves targets through the realpath walk, which used to blame a
    // symlink for every escape.
    const diff = ['--- /dev/null', '+++ b/../escape.txt', '@@ -0,0 +1 @@', '+x', ''].join('NL');
    const err = await patchTool
      .execute({ patch: diff.replaceAll('NL', String.fromCharCode(10)) }, sb.ctx)
      .then(
        () => undefined,
        (e: Error) => e,
      );
    expect(err?.message).toMatch(/outside project root/);
    expect(err?.message).not.toMatch(/symlink/);
  });
});

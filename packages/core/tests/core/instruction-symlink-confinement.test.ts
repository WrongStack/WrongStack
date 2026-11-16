/**
 * Repository-supplied instruction files are read without a tool call, so the
 * file tools' realpath containment never sees them. A committed symlink
 * (`AGENTS.md -> ~/.aws/credentials`, `.wrongstack/instructions/system.md ->
 * …`, a `sections` junction) used to put an arbitrary host file into the
 * system prompt or the context. Links that stay inside the project still work.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadInstructionBundle } from '../../src/core/instruction-bundle.js';
import {
  queueDirectoryInstructions,
  RootInstructionsCache,
} from '../../src/core/project-instructions.js';

let base = '';
let root = '';
let instructions = '';
const SECRET = 'OUTSIDE-THE-PROJECT';

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'instr-symlink-')));
  root = path.join(base, 'repo');
  fs.mkdirSync(path.join(base, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(base, 'secret.md'), SECRET);
  fs.writeFileSync(path.join(base, 'notes', 'keys.md'), SECRET);
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', 'index.ts'), '');
  fs.symlinkSync(path.join(base, 'secret.md'), path.join(root, 'AGENTS.md'), 'file');
  fs.symlinkSync(path.join(base, 'secret.md'), path.join(root, 'pkg', 'AGENTS.md'), 'file');
  fs.writeFileSync(path.join(root, 'pkg', 'CLAUDE.md'), 'pkg rules');
  instructions = path.join(root, '.wrongstack', 'instructions');
  fs.mkdirSync(instructions, { recursive: true });
  fs.symlinkSync(path.join(base, 'secret.md'), path.join(instructions, 'system.md'), 'file');
  fs.symlinkSync(path.join(base, 'notes'), path.join(instructions, 'sections'), 'junction');
  fs.writeFileSync(path.join(instructions, 'leader-after-task.md'), 'leader rules');
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('instruction files that resolve outside the project', () => {
  it('are not put into the system prompt (root AGENTS.md)', async () => {
    expect(await new RootInstructionsCache().load(root)).not.toContain(SECRET);
  });

  it('are skipped for a directory, which falls back to its CLAUDE.md', async () => {
    const ctx = { projectRoot: root, workingDir: root } as { pendingPostToolContext?: string };
    await queueDirectoryInstructions(
      { capabilities: ['fs.read'] },
      { path: 'pkg/index.ts' },
      ctx as never,
    );
    expect(ctx.pendingPostToolContext ?? '').toContain('pkg rules');
    expect(ctx.pendingPostToolContext ?? '').not.toContain(SECRET);
  });

  it('are dropped from the project instruction layer, which keeps its own files', async () => {
    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const bundle = await loadInstructionBundle({ bundledDir: empty, projectDir: instructions });
    expect(JSON.stringify(bundle)).not.toContain(SECRET);
    expect(bundle.system?.leaderAfterTask).toBe('leader rules');
  });

  it('strips UTF-8 BOM from instruction bundle JSON files (F500)', async () => {
    const empty = path.join(base, 'bom-bundle');
    fs.mkdirSync(empty, { recursive: true });
    const file = path.join(empty, 'instructions.json');
    fs.writeFileSync(
      file,
      `\uFEFF${JSON.stringify({ version: 1, system: { identity: 'Custom sys' } })}`,
      'utf8',
    );
    const bundle = await loadInstructionBundle({ bundledDir: empty, files: [file] });
    expect(bundle.system?.identity).toBe('Custom sys');
  });
});

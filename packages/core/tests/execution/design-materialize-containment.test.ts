/**
 * WS-021 / WS-052 — `design.materialize` write containment.
 *
 * `materializeTokens` returns the caller-supplied `outPath` verbatim and each
 * consumer was responsible for containing it. The LLM-tool path was hardened
 * for issue #249; the WebSocket handler and the two slash-command paths were
 * not, so a payload-supplied `out` reached `fs.writeFile` unchecked — and
 * `.git/hooks/pre-commit` turns an arbitrary write into execution.
 *
 * All four now share `resolveMaterializeTarget`, so a future fix cannot land on
 * one site again.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveMaterializeTarget } from '../../src/execution/design-materialize.js';

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-contain-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('resolveMaterializeTarget', () => {
  it('accepts a plain relative path', async () => {
    const abs = await resolveMaterializeTarget('src/tokens.css', root);
    expect(abs.startsWith(await fs.realpath(root))).toBe(true);
    expect(abs.endsWith('tokens.css')).toBe(true);
  });

  it('accepts a nested path whose directory does not exist yet', async () => {
    const abs = await resolveMaterializeTarget('a/b/c/tokens.css', root);
    expect(abs.startsWith(await fs.realpath(root))).toBe(true);
  });

  it('rejects a parent-directory escape', async () => {
    await expect(resolveMaterializeTarget('../escaped.css', root)).rejects.toThrow(
      /escape the project root/,
    );
  });

  it('rejects the deep traversal that reaches the user profile config', async () => {
    await expect(
      resolveMaterializeTarget('../../../../.wrongstack/profiles/default/config.json', root),
    ).rejects.toThrow(/escape the project root/);
  });

  it('rejects a git-hook write, the arbitrary-write-to-execution pivot', async () => {
    await expect(resolveMaterializeTarget('../.git/hooks/pre-commit', root)).rejects.toThrow(
      /escape the project root/,
    );
  });

  it('rejects an absolute path outside the root', async () => {
    const outside = path.join(os.tmpdir(), 'design-outside.css');
    await expect(resolveMaterializeTarget(outside, root)).rejects.toThrow(
      /escape the project root/,
    );
  });

  it('accepts an absolute path that is inside the root', async () => {
    const inside = path.join(root, 'src', 'inside.css');
    const abs = await resolveMaterializeTarget(inside, root);
    expect(abs.endsWith('inside.css')).toBe(true);
  });

  it('rejects a sibling directory sharing the root name prefix', async () => {
    const sibling = `${root}-evil`;
    await fs.mkdir(sibling, { recursive: true });
    try {
      await expect(resolveMaterializeTarget(path.join(sibling, 'x.css'), root)).rejects.toThrow(
        /escape the project root/,
      );
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });
});

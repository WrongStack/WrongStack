import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotMemoryEvidence } from '../../src/retrieval/source-evidence.js';
import type { Sage } from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-source-evidence-surrogate-'));
  roots.push(dir);
  return dir;
}

function memory(paths: string[]): Sage {
  return {
    anchors: paths.map((file) => ({ type: 'file', path: file })),
    sources: [],
  } as unknown as Sage;
}

/** True when `s` contains an unpaired surrogate half. */
function containsLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('snapshotMemoryEvidence surrogate-safe excerpt cap', () => {
  // The evidence excerpts feed the memory-companion subagent prompt and the
  // verdict quote corpus (model-bound text). An astral character straddling
  // the 6000-character cut used to leave an orphaned surrogate half in
  // files[].text — ill-formed text the convention forbids on model-bound
  // surfaces (see r22: system-one-recall.ts, same class).
  it('drops a straddling astral character whole at the 6000-character cap', async () => {
    const root = await createRoot();
    const content = `${'a'.repeat(5999)}\u{1F600}${'b'.repeat(10)}`;
    await fs.writeFile(path.join(root, 'evidence.md'), content, 'utf8');

    const snapshot = await snapshotMemoryEvidence(root, memory(['evidence.md']));
    const text = snapshot.files[0]?.text ?? '';
    expect(text.length).toBe(5999);
    expect(text).toBe('a'.repeat(5999));
    expect(containsLoneSurrogate(text)).toBe(false);
  });

  it('keeps an astral character intact when it does not straddle the cap', async () => {
    const root = await createRoot();
    const content = `\u{1F600}${'a'.repeat(50)}`;
    await fs.writeFile(path.join(root, 'control.md'), content, 'utf8');

    const snapshot = await snapshotMemoryEvidence(root, memory(['control.md']));
    expect(snapshot.files[0]?.text).toBe(content);
    expect(containsLoneSurrogate(snapshot.files[0]?.text ?? '')).toBe(false);
  });

  it('still binds the anchor hash to the full file content', async () => {
    const root = await createRoot();
    const content = `${'a'.repeat(5999)}\u{1F600}${'b'.repeat(10)}`;
    const file = path.join(root, 'evidence.md');
    await fs.writeFile(file, content, 'utf8');
    const m = memory(['evidence.md']);

    const first = await snapshotMemoryEvidence(root, m);
    expect(first.files[0]?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    m.anchors[0]!.contentHash = first.files[0]!.hash;
    expect((await snapshotMemoryEvidence(root, m)).changedAnchor).toBe(false);

    await fs.writeFile(file, `${content} changed`, 'utf8');
    expect((await snapshotMemoryEvidence(root, m)).changedAnchor).toBe(true);
  });
});

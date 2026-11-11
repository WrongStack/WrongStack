import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `patches/ink@8.0.0.patch` keeps Ink's tokenization caches for the life of
 * the process. Stock Ink builds a fresh, empty cache set for every frame, so
 * text that never changes (the sidebar, the status bar, the visible history)
 * was re-tokenized on every frame: about a quarter of streaming CPU.
 *
 * The patch lives outside this package and is applied at install time, so an
 * Ink upgrade or a dropped `patchedDependencies` entry would silently bring
 * the cost back. These tests fail loudly instead.
 */
interface OutputLike {
  caches: { styledChars: Map<string, unknown>; lines: Map<string, unknown> };
  write(x: number, y: number, text: string, options: { transformers: unknown[] }): void;
  get(): { output: string; height: number };
}

async function loadInkOutput(): Promise<
  new (size: {
    width: number;
    height: number;
  }) => OutputLike
> {
  const require = createRequire(import.meta.url);
  const outputPath = join(dirname(require.resolve('ink')), 'output.js');
  return (await import(pathToFileURL(outputPath).href)).default;
}

describe('Ink output caches (patches/ink@8.0.0.patch)', () => {
  it('shares one cache set between frames', async () => {
    const Output = await loadInkOutput();
    const first = new Output({ width: 20, height: 2 });
    const second = new Output({ width: 20, height: 2 });
    expect(
      second.caches,
      'Ink is unpatched: reapply patches/ink@8.0.0.patch (bun install) or port it to the new Ink version',
    ).toBe(first.caches);
  });

  it('reuses a tokenized line on the next frame and renders it identically', async () => {
    const Output = await loadInkOutput();
    const text = '\x1b[1mshared-cache-probe\x1b[22m line\nsecond \x1b[38;2;10;200;90mrow\x1b[39m';
    const render = (): { frame: string; output: OutputLike } => {
      const output = new Output({ width: 30, height: 3 });
      output.write(1, 0, text, { transformers: [] });
      return { frame: output.get().output, output };
    };
    const first = render();
    const tokenized = first.output.caches.styledChars.get(text);
    expect(tokenized).toBeDefined();
    const second = render();
    // Same array instance: the second frame did not tokenize the text again.
    expect(second.output.caches.styledChars.get(text)).toBe(tokenized);
    expect(second.frame).toBe(first.frame);
    expect(first.frame).toContain('shared-cache-probe');
    expect(first.frame.split('\n')).toHaveLength(3);
  });

  it('keeps the caches bounded', async () => {
    const Output = await loadInkOutput();
    const output = new Output({ width: 10, height: 1 });
    for (let i = 0; i < 20_500; i++) output.caches.lines.set(`bound-probe-${i}`, []);
    output.get();
    expect(output.caches.lines.size).toBe(0);
  });
});

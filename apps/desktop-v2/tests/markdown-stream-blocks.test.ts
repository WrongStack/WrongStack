import { describe, expect, it } from 'vitest';
import { scanStreamBlocks } from '../src/MarkdownContent';

function splitStreamBlocks(text: string) {
  const { blocks, tail } = scanStreamBlocks(text);
  return [blocks, tail] as const;
}

describe('streaming answer blocks', () => {
  it('keeps completed paragraphs as blocks and the paragraph being written as the tail', () => {
    const [blocks, tail] = splitStreamBlocks('# Title\n\nFirst paragraph.\n\nStill writ');
    expect(blocks).toEqual(['# Title\n\n', 'First paragraph.\n\n']);
    expect(tail).toBe('Still writ');
    expect(blocks.join('') + tail).toBe('# Title\n\nFirst paragraph.\n\nStill writ');
  });
  it('never ends a block inside an open code fence', () => {
    const text = 'Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n';
    const [blocks, tail] = splitStreamBlocks(text);
    expect(blocks).toEqual(['Intro\n\n']);
    expect(tail).toBe('```ts\nconst a = 1;\n\nconst b = 2;\n');
  });
  it('closes a fenced block at the first blank line after its fence', () => {
    const text = '```ts\nconst a = 1;\n```\n\nAfter';
    expect(splitStreamBlocks(text)).toEqual([['```ts\nconst a = 1;\n```\n\n'], 'After']);
  });
  it('keeps earlier blocks identical as the answer grows', () => {
    const full = 'One.\n\nTwo.\n\nThree.\n\nFour';
    const earlier = splitStreamBlocks(full.slice(0, 14))[0];
    const later = splitStreamBlocks(full)[0];
    expect(later.slice(0, earlier.length)).toEqual(earlier);
  });
  it('returns the whole text as the tail when no paragraph has completed', () => {
    expect(splitStreamBlocks('Just started')).toEqual([[], 'Just started']);
    expect(splitStreamBlocks('')).toEqual([[], '']);
  });

  it('reuses the completed paragraphs while tokens extend an unfinished line', () => {
    const before = scanStreamBlocks('First paragraph.\n\nStill');
    const after = scanStreamBlocks(`${before.text} being written`, before);
    expect(after.blocks).toBe(before.blocks);
    expect(after.tail).toBe('Still being written');
    expect(scanStreamBlocks(after.text, after)).toBe(after);
  });

  it('matches a single scan at every append boundary, including inside a code fence', () => {
    const full = 'Intro\r\n\r\n~~~ts\r\nfirst()\r\n\r\nlast()\r\n~~~\r\n\r\nParagraph\n\nTail';
    let current = scanStreamBlocks('');
    for (let end = 1; end <= full.length; end++) {
      const text = full.slice(0, end);
      current = scanStreamBlocks(text, current);
      expect(current).toEqual(scanStreamBlocks(text));
    }
    expect(current.blocks.join('') + current.tail).toBe(full);
  });

  it('rescans replacement or truncated content without retaining stale cached paragraphs', () => {
    const before = scanStreamBlocks('Intro\n\n~~~ts\nunfinished()');
    const rewritten = 'Edited intro\n\nFinished paragraph\n\nTail';
    const after = scanStreamBlocks(rewritten, before);
    expect(after.blocks).toEqual(['Edited intro\n\n', 'Finished paragraph\n\n']);
    expect(scanStreamBlocks('Edited intro', after).tail).toBe('Edited intro');
    expect(scanStreamBlocks('', after).blocks).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { splitStreamBlocks } from '../src/MarkdownContent';

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
});

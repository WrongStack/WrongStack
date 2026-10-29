import type { Message } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import {
  projectSessionTranscript,
  readSessionTranscriptBlock,
  readSessionTranscriptBlocks,
  readSessionTranscriptImage,
  readSessionTranscriptToolInput,
} from '../src/server/session-transcript.js';

describe('bounded retained session transcript', () => {
  it('searches beyond excerpts and excludes opaque media payloads and thinking signatures', () => {
    const text = 'x'.repeat(40000) + 'find-this-late-needle';
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          {
            type: 'image',
            source: { type: 'base64', data: 'opaque-private-bytes', media_type: 'image/png' },
          },
          {
            type: 'document',
            name: 'notes.pdf',
            text: 'Extracted PDF text',
            source: { type: 'base64', media_type: 'application/pdf', data: 'opaque-pdf-bytes' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Recorded reasoning',
            signature: 'opaque-thinking-signature',
          },
        ],
      },
    ];
    const page = projectSessionTranscript(messages, { query: 'find-this-late-needle' });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.blocks[0]).toMatchObject({ textOffset: 39700 });
    expect(JSON.stringify(page)).toContain('find-this-late-needle');
    const all = JSON.stringify(projectSessionTranscript(messages, {}));
    expect(all).not.toContain('opaque-private-bytes');
    expect(all).not.toContain('opaque-pdf-bytes');
    expect(all).not.toContain('opaque-thinking-signature');
    expect(all).toContain('Extracted PDF text');
  });
  it('reads all long text in bounded Unicode-safe chunks and refuses stale text reads', () => {
    const text = 'a'.repeat(15999) + '😀' + 'b'.repeat(17000);
    const messages: Message[] = [{ role: 'assistant', content: text }];
    const page = projectSessionTranscript(messages, {});
    let offset = 0,
      recovered = '';
    do {
      const part = readSessionTranscriptBlock(messages, {
        expectedRevision: page.revision,
        messageIndex: 0,
        blockIndex: 0,
        offset,
      });
      expect(part.text.length).toBeLessThanOrEqual(16000);
      recovered += part.text;
      if (part.nextTextOffset === null) break;
      expect(part.nextTextOffset).toBeGreaterThan(offset);
      offset = part.nextTextOffset;
    } while (recovered.length < text.length);
    expect(recovered).toBe(text);
    expect(() =>
      readSessionTranscriptBlock([{ role: 'user', content: 'changed' }], {
        expectedRevision: page.revision,
        messageIndex: 0,
        blockIndex: 0,
      }),
    ).toThrow(/changed/);
  });
  it('reads one retained raster image on explicit request, bounded and revision-checked', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look' },
          { type: 'image', source: { type: 'base64', data: png, media_type: 'image/png' } },
          {
            type: 'image',
            source: { type: 'base64', data: 'PHN2Zz4=', media_type: 'image/svg+xml' },
          },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        ],
      },
    ];
    const { revision } = projectSessionTranscript(messages, {});
    const read = (blockIndex: number, expectedRevision = revision) =>
      readSessionTranscriptImage(messages, { expectedRevision, messageIndex: 0, blockIndex });
    expect(read(1)).toEqual({
      revision,
      messageIndex: 0,
      blockIndex: 1,
      mediaType: 'image/png',
      dataUrl: `data:image/png;base64,${png}`,
    });
    expect(() => read(2)).toThrow(/not a raster image/);
    expect(() => read(3)).toThrow(/not stored in the session/);
    expect(() => read(0)).toThrow(/not an image/);
    expect(() => read(1, 'stale')).toThrow(/changed/);
    const huge: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', data: 'A'.repeat(6_000_000), media_type: 'image/png' },
          },
        ],
      },
    ];
    expect(() =>
      readSessionTranscriptImage(huge, {
        expectedRevision: projectSessionTranscript(huge, {}).revision,
        messageIndex: 0,
        blockIndex: 0,
      }),
    ).toThrow(/too large/);
  });
  it('reads the blocks of a long message beyond the first hundred, in bounded pages', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: Array.from({ length: 230 }, (_, i) => ({ type: 'text' as const, text: `b${i}` })),
      },
    ];
    const page = projectSessionTranscript(messages, {});
    expect(page.messages[0]).toMatchObject({ omittedBlocks: 130 });
    const read = (blockOffset: number, expectedRevision = page.revision) =>
      readSessionTranscriptBlocks(messages, { expectedRevision, messageIndex: 0, blockOffset });
    const second = read(100);
    expect(second.blocks).toHaveLength(100);
    expect(second.blocks[0]).toMatchObject({ index: 100, text: 'b100' });
    expect(second.nextBlockOffset).toBe(200);
    const last = read(200);
    expect(last.blocks.map((block) => block.index)).toEqual(
      Array.from({ length: 30 }, (_, i) => 200 + i),
    );
    expect(last.nextBlockOffset).toBeNull();
    expect(() => read(231)).toThrow(/outside/);
    expect(() => read(100, 'stale')).toThrow(/changed/);
  });
  it('reads one complete tool input on request, bounded and revision-checked', () => {
    const big = 'x'.repeat(20000);
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'run' },
          { type: 'tool_use', id: 'call-1', name: 'write', input: { path: 'a.ts', content: big } },
          {
            type: 'tool_use',
            id: 'call-2',
            name: 'write',
            input: { content: 'y'.repeat(1_100_000) },
          },
        ],
      },
    ];
    const page = projectSessionTranscript(messages, {});
    // The page keeps its bounded preview.
    expect(JSON.stringify(page)).not.toContain(big);
    const read = (blockIndex: number, expectedRevision = page.revision) =>
      readSessionTranscriptToolInput(messages, { expectedRevision, messageIndex: 0, blockIndex });
    expect(read(1)).toEqual({
      revision: page.revision,
      messageIndex: 0,
      blockIndex: 1,
      name: 'write',
      toolId: 'call-1',
      input: { path: 'a.ts', content: big },
    });
    expect(() => read(0)).toThrow(/not a tool request/);
    expect(() => read(2)).toThrow(/too large/);
    expect(() => read(1, 'stale')).toThrow(/changed/);
  });
  it('applies role filters, stable paging and input bounds without changing messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Original' },
      { role: 'assistant', content: 'Answer' },
    ];
    expect(
      projectSessionTranscript(messages, { role: 'assistant' }).messages.map((item) => item.index),
    ).toEqual([1]);
    expect(projectSessionTranscript(messages, { limit: 1 }).nextOffset).toBe(1);
    expect(projectSessionTranscript(messages, { offset: 1, limit: 1 }).nextOffset).toBeNull();
    for (const options of [
      { limit: 0 },
      { limit: 1000 },
      { offset: -1 },
      { offset: 3 },
      { query: 'q'.repeat(501) },
      { role: 'invented' },
    ])
      expect(() => projectSessionTranscript(messages, options)).toThrow();
    expect(messages[0]?.content).toBe('Original');
  });
});

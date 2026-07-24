import { describe, expect, it } from 'vitest';
import { preparePromptInsertion, prepareResourceInsertion } from '../src/content-selection.js';

describe('MCP explicit content selection', () => {
  it('wraps resource contents with untrusted provenance and exact byte size', () => {
    const insertion = prepareResourceInsertion(
      'docs',
      'repo://guide',
      {
        contents: [
          { uri: 'repo://guide', mimeType: 'text/plain', text: 'ş' },
          { uri: 'mem://image', mimeType: 'image/png', blob: 'aGVsbG8=' },
        ],
      },
      { maxBytes: 16 },
    );

    expect(insertion).toMatchObject({
      kind: 'resource',
      untrusted: true,
      byteSize: 7,
      provenance: {
        origin: 'mcp',
        serverName: 'docs',
        capability: 'resource',
        resourceUri: 'repo://guide',
      },
    });
  });

  it('enforces content size, valid base64, and URI scheme policy', () => {
    expect(() => prepareResourceInsertion('docs', 'javascript:alert(1)', { contents: [] })).toThrow(
      /scheme "javascript" is not allowed/,
    );
    expect(() =>
      prepareResourceInsertion('docs', 'https://user:pass@example.test/a', { contents: [] }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      prepareResourceInsertion('docs', 'https://:pass@example.test/a', { contents: [] }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      prepareResourceInsertion('docs', 'mem://one', {
        contents: [{ uri: 'mem://one', blob: 'not base64' }],
      }),
    ).toThrow(/invalid base64/);
    expect(() =>
      prepareResourceInsertion(
        'docs',
        'mem://one',
        { contents: [{ uri: 'mem://one', text: 'hello' }] },
        { maxBytes: 4 },
      ),
    ).toThrow(/4-byte content limit/);
  });

  it('permits explicitly configured custom schemes', () => {
    expect(
      prepareResourceInsertion(
        'custom',
        'acme://record/1',
        { contents: [{ uri: 'acme://record/1', text: 'ok' }] },
        { allowedUriSchemes: ['acme'] },
      ).contents[0]?.text,
    ).toBe('ok');
  });

  it('preserves rich prompt blocks and records argument names without values', () => {
    const insertion = preparePromptInsertion(
      'prompts',
      'review',
      { secret: 'do-not-record', target: 'src/' },
      {
        description: 'Review code',
        messages: [
          {
            role: 'user',
            content: { type: 'resource_link', uri: 'repo://src/index.ts', name: 'entry' },
          },
        ],
      },
    );

    expect(insertion.provenance).toEqual({
      origin: 'mcp',
      serverName: 'prompts',
      capability: 'prompt',
      promptName: 'review',
      promptArgumentNames: ['secret', 'target'],
    });
    expect(JSON.stringify(insertion)).not.toContain('do-not-record');
    expect(insertion.messages[0]?.content).toMatchObject({ type: 'resource_link' });
  });

  it('validates embedded prompt resource URIs before insertion', () => {
    expect(() =>
      preparePromptInsertion('prompts', 'unsafe', undefined, {
        messages: [
          {
            role: 'assistant',
            content: { type: 'resource_link', uri: 'javascript:alert(1)' },
          },
        ],
      }),
    ).toThrow(/scheme "javascript" is not allowed/);
  });

  it('rejects empty and huge URIs', () => {
    expect(() => prepareResourceInsertion('docs', '', { contents: [] })).toThrow(
      /must contain 1–8192 characters/,
    );
    expect(() =>
      prepareResourceInsertion('docs', 'file:' + 'a'.repeat(8193), { contents: [] }),
    ).toThrow(/must contain 1–8192 characters/);
  });

  it('rejects non-absolute URIs', () => {
    expect(() => prepareResourceInsertion('docs', 'not-a-valid-url', { contents: [] })).toThrow(
      /must be absolute/,
    );
  });

  it('rejects maxBytes that is not a positive safe integer', () => {
    expect(() =>
      prepareResourceInsertion(
        'docs',
        'mem://one',
        { contents: [{ uri: 'mem://one', text: 'hi' }] },
        { maxBytes: -1 },
      ),
    ).toThrow(/must be a positive safe integer/);
    expect(() =>
      prepareResourceInsertion(
        'docs',
        'mem://one',
        { contents: [{ uri: 'mem://one', text: 'hi' }] },
        { maxBytes: 0 },
      ),
    ).toThrow(/must be a positive safe integer/);
  });

  it('rejects server names and prompt names outside 1-256 characters', () => {
    expect(() => prepareResourceInsertion('', 'mem://one', { contents: [] })).toThrow(
      /must contain 1–256 characters/,
    );
    expect(() => prepareResourceInsertion('x'.repeat(257), 'mem://one', { contents: [] })).toThrow(
      /must contain 1–256 characters/,
    );
    expect(() =>
      preparePromptInsertion('', 'prompt', undefined, {
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
      }),
    ).toThrow(/server name/);
    expect(() =>
      preparePromptInsertion('server', '', undefined, {
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
      }),
    ).toThrow(/prompt name/);
  });

  it('rejects resource insertion with more than 64 content blocks', () => {
    const contents = Array.from({ length: 65 }, (_, i) => ({
      uri: 'mem://one',
      text: `block ${i}`,
    }));
    expect(() => prepareResourceInsertion('docs', 'mem://one', { contents })).toThrow(
      /exceeds the limit of 64 content blocks/,
    );
  });

  it('rejects prompt insertion with more than 128 messages', () => {
    const messages = Array.from({ length: 129 }, (_, i) => ({
      role: 'user' as const,
      content: { type: 'text', text: `msg ${i}` },
    }));
    expect(() => preparePromptInsertion('server', 'big', undefined, { messages })).toThrow(
      /exceeds the limit of 128 messages/,
    );
  });

  it('rejects prompt content with non-serializable values', () => {
    const msg: Record<string, unknown> = {
      role: 'user',
      content: { type: 'text', text: 'hi' },
    };
    (msg as Record<string, unknown>).loop = msg;
    expect(() =>
      preparePromptInsertion('server', 'circ', undefined, {
        description: 'test',
        messages: [msg as never],
      }),
    ).toThrow(/non-serializable content/);
  });

  it('skips URI validation for primitive message content', () => {
    const insertion = preparePromptInsertion('server', 'prim', undefined, {
      messages: [
        {
          role: 'user',
          content: 'just a plain string, not an object',
        },
      ],
    });
    expect(insertion.messages[0]?.content).toBe('just a plain string, not an object');
  });

  it('validates embedded URIs inside array content', () => {
    expect(() =>
      preparePromptInsertion('server', 'arr', undefined, {
        messages: [
          {
            role: 'user',
            content: [{ uri: 'javascript:alert(1)' }],
          },
        ],
      }),
    ).toThrow(/scheme "javascript" is not allowed/);

    expect(
      preparePromptInsertion('server', 'arr', undefined, {
        messages: [
          {
            role: 'user',
            content: [{ uri: 'mem://safe' }, { type: 'text', text: 'ok' }],
          },
        ],
      }).messages[0]?.content,
    ).toHaveLength(2);
  });

  it('counts base64 padding variants exactly', () => {
    const insertion = prepareResourceInsertion('docs', 'mem://one', {
      contents: [
        { uri: 'mem://one', blob: 'TQ==' },
        { uri: 'mem://two', blob: 'TWFu' },
      ],
    });

    expect(insertion.byteSize).toBe(4);
  });

  it('rejects oversized and deeply nested prompt content', () => {
    expect(() =>
      preparePromptInsertion(
        'prompts',
        'large',
        undefined,
        { messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }] },
        { maxBytes: 4 },
      ),
    ).toThrow(/4-byte content limit/);

    let content: Record<string, unknown> = { type: 'text' };
    for (let index = 0; index < 34; index++) content = { nested: content };
    expect(() =>
      preparePromptInsertion('prompts', 'deep', undefined, {
        messages: [{ role: 'user', content }],
      }),
    ).toThrow(/nesting depth limit/);
  });
});

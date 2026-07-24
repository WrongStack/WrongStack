import { describe, expect, it } from 'vitest';
import {
  parseGetPromptResult,
  parseListPromptsResult,
  parseListResourcesResult,
  parseListResourceTemplatesResult,
  parseReadResourceResult,
  parseServerMetadata,
} from '../src/protocol.js';

describe('MCP resources and prompts protocol parsing', () => {
  it('parses negotiated server metadata without discarding capabilities', () => {
    const metadata = parseServerMetadata({
      protocolVersion: '2025-06-18',
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        experimental: { vendor: true },
      },
      serverInfo: { name: 'fixture', version: '2.1.0', title: 'Fixture server' },
      instructions: 'Select content explicitly.',
    });

    expect(metadata.capabilities.resources).toEqual({ subscribe: true, listChanged: true });
    expect(metadata.capabilities.experimental).toEqual({ vendor: true });
    expect(metadata.serverInfo.title).toBe('Fixture server');
  });

  it('parses paginated resources and templates', () => {
    expect(
      parseListResourcesResult({
        resources: [
          {
            uri: 'file:///guide.md',
            name: 'guide',
            mimeType: 'text/markdown',
            size: 42,
            annotations: { audience: ['user'] },
          },
        ],
        nextCursor: 'page-2',
      }),
    ).toMatchObject({ resources: [{ name: 'guide', size: 42 }], nextCursor: 'page-2' });

    expect(
      parseListResourceTemplatesResult({
        resourceTemplates: [{ uriTemplate: 'repo://{path}', name: 'repository file' }],
      }).resourceTemplates[0],
    ).toMatchObject({ uriTemplate: 'repo://{path}', name: 'repository file' });
  });

  it('parses text and blob resource contents', () => {
    const result = parseReadResourceResult({
      contents: [
        { uri: 'mem://one', mimeType: 'text/plain', text: 'hello' },
        { uri: 'mem://two', mimeType: 'application/octet-stream', blob: 'aGVsbG8=' },
      ],
    });
    expect(result.contents).toHaveLength(2);
    expect(result.contents[1]?.blob).toBe('aGVsbG8=');
  });

  it('preserves rich prompt content rather than flattening it to text', () => {
    const prompts = parseListPromptsResult({
      prompts: [
        {
          name: 'review',
          arguments: [{ name: 'target', required: true }],
        },
      ],
      nextCursor: 'more',
    });
    expect(prompts.prompts[0]?.arguments?.[0]).toEqual({
      name: 'target',
      description: undefined,
      required: true,
    });

    const content = { type: 'resource_link', uri: 'repo://src/index.ts', name: 'entrypoint' };
    const prompt = parseGetPromptResult({
      description: 'Review a file',
      messages: [{ role: 'user', content }],
    });
    expect(prompt.messages[0]?.content).toEqual(content);
  });

  it.each([
    [() => parseServerMetadata({}), /initialize\.serverInfo/],
    [() => parseListResourcesResult({ resources: 'nope' }), /resources must be an array/],
    [() => parseReadResourceResult({ contents: [{ uri: 'mem://x' }] }), /text or blob/],
    [() => parseListPromptsResult({ prompts: [{ name: 'x', arguments: {} }] }), /arguments/],
    [
      () => parseGetPromptResult({ messages: [{ role: 'system', content: { type: 'text' } }] }),
      /role/,
    ],
  ])('rejects malformed protocol payloads', (parse, expected) => {
    expect(parse).toThrow(expected);
  });

  it('throws for resources/read result with non-array contents', () => {
    expect(() => parseReadResourceResult({ contents: 'not-an-array' })).toThrow(
      /contents must be an array/,
    );
  });

  it('throws when prompt argument required field is not a boolean', () => {
    expect(() =>
      parseListPromptsResult({
        prompts: [{ name: 'p1', arguments: [{ name: 'a1', required: 'yes' }] }],
      }),
    ).toThrow(/required/);
  });

  it('throws when prompts/list result has non-array prompts', () => {
    expect(() => parseListPromptsResult({ prompts: 'not-an-array' })).toThrow(
      /prompts must be an array/,
    );
  });

  it('throws when prompts/get message has undefined content', () => {
    expect(() =>
      parseGetPromptResult({
        messages: [{ role: 'user' }],
      }),
    ).toThrow(/content/);
  });

  it('parses list resources result without nextCursor', () => {
    const result = parseListResourcesResult({
      resources: [{ uri: 'file:///a', name: 'a' }],
    });
    expect(result.nextCursor).toBeUndefined();
  });

  it('parses list resource templates with title, description, mimeType, annotations', () => {
    const result = parseListResourceTemplatesResult({
      resourceTemplates: [
        {
          uriTemplate: 'file://{path}',
          name: 'template',
          title: 'Template',
          description: 'A file template',
          mimeType: 'text/plain',
          annotations: { audience: ['user'] },
        },
      ],
    });
    expect(result.resourceTemplates[0]?.title).toBe('Template');
    expect(result.resourceTemplates[0]?.annotations).toEqual({ audience: ['user'] });
  });

  it('throws on resource with invalid size field', () => {
    expect(() =>
      parseListResourcesResult({
        resources: [{ uri: 'file:///a', name: 'a', size: -1 }],
      }),
    ).toThrow(/size/);
  });

  it('parses server metadata without optional instructions and title', () => {
    const metadata = parseServerMetadata({
      protocolVersion: '2025-06-18',
      capabilities: {},
      serverInfo: { name: 'test', version: '1.0' },
    });
    expect(metadata.instructions).toBeUndefined();
    expect(metadata.serverInfo.title).toBeUndefined();
  });

  it('throws for templates list with non-array resourceTemplates', () => {
    expect(() => parseListResourceTemplatesResult({ resourceTemplates: 'not-array' })).toThrow(
      /resourceTemplates must be an array/,
    );
  });

  it('throws when optional string field receives a non-string, non-undefined value', () => {
    expect(() =>
      parseServerMetadata({
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'test', version: '1.0', title: 123 as never },
      }),
    ).toThrow(/expected string/);
  });

  it('throws when server metadata has non-string instructions', () => {
    expect(() =>
      parseServerMetadata({
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'test', version: '1.0' },
        instructions: 42 as never,
      }),
    ).toThrow(/expected string/);
  });
});

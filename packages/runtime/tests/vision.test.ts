import type { Context } from '@wrongstack/core/agent';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { Tool } from '@wrongstack/core/types';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createToolVisionAdapters,
  ImageInputUnsupportedError,
  routeImagesForModel,
  VisionUrlBlockedError,
} from '../src/vision.js';

const image = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' },
};

const ctx = {} as Context;

describe('vision routing', () => {
  it('returns the none route when there are no images', async () => {
    const blocks = [{ type: 'text' as const, text: 'plain text' }];
    await expect(
      routeImagesForModel(blocks, {
        supportsVision: false,
        ctx,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ blocks, route: 'none', convertedImages: 0 });
  });

  it('keeps image blocks intact when the model supports native vision', async () => {
    const result = await routeImagesForModel([{ type: 'text', text: 'look' }, image], {
      supportsVision: true,
      ctx,
      signal: new AbortController().signal,
    });

    expect(result.route).toBe('native');
    expect(result.blocks[1]).toBe(image);
  });

  it('blocks private image URLs even when the model supports native vision', async () => {
    const urlImage = {
      type: 'image' as const,
      source: { type: 'url' as const, url: 'http://localhost/a.png', media_type: 'image/png' },
    };
    await expect(
      routeImagesForModel([urlImage], {
        supportsVision: true,
        ctx,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(VisionUrlBlockedError);
  });

  it('allows public image URLs when the model supports native vision', async () => {
    const urlImage = {
      type: 'image' as const,
      source: { type: 'url' as const, url: 'https://example.com/a.png', media_type: 'image/png' },
    };
    const result = await routeImagesForModel([urlImage], {
      supportsVision: true,
      ctx,
      signal: new AbortController().signal,
    });
    expect(result.route).toBe('native');
    expect(result.blocks[0]).toBe(urlImage);
  });

  it('throws a clear error when images have no native or adapter route', async () => {
    await expect(
      routeImagesForModel([image], {
        supportsVision: false,
        ctx,
        signal: new AbortController().signal,
        providerId: 'zai',
        model: 'text-only',
      }),
    ).rejects.toBeInstanceOf(ImageInputUnsupportedError);
  });

  it('describes the current model and plural images when no target is named', async () => {
    await expect(
      routeImagesForModel([image, image], {
        supportsVision: false,
        ctx,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/current model.*2 images/);
  });

  it('reports malformed native image URLs as unresolvable', async () => {
    await expect(
      routeImagesForModel([{ type: 'image', source: { type: 'url', url: 'not a url' } } as never], {
        supportsVision: true,
        ctx,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/unresolvable host/);
  });

  it('converts images through a vision adapter for text-only models', async () => {
    const result = await routeImagesForModel([{ type: 'text', text: 'what?' }, image], {
      supportsVision: false,
      ctx,
      signal: new AbortController().signal,
      adapters: [
        {
          name: 'test-vision',
          async describe() {
            return 'A screenshot with an error dialog.';
          },
        },
      ],
    });

    expect(result.route).toBe('adapter');
    expect(result.blocks).toEqual([
      { type: 'text', text: 'what?' },
      {
        type: 'text',
        text: '[Image 1 analyzed via test-vision]\nA screenshot with an error dialog.',
      },
    ]);
  });

  it('resolves adapter providers at routing time', async () => {
    let calls = 0;
    const result = await routeImagesForModel([image], {
      supportsVision: false,
      ctx,
      signal: new AbortController().signal,
      adapters: () => {
        calls++;
        return [
          {
            name: 'late-vision',
            async describe() {
              return 'late MCP tool saw the image';
            },
          },
        ];
      },
    });

    expect(calls).toBe(1);
    expect(result.adapterName).toBe('late-vision');
    expect(result.blocks).toEqual([
      {
        type: 'text',
        text: '[Image 1 analyzed via late-vision]\nlate MCP tool saw the image',
      },
    ]);
  });

  it('tries later adapters after failures and reports terminal adapter errors', async () => {
    const good = {
      name: 'good',
      async describe() {
        return 'worked';
      },
    };
    const result = await routeImagesForModel([image], {
      supportsVision: false,
      ctx,
      signal: new AbortController().signal,
      adapters: [
        {
          name: 'broken',
          async describe() {
            throw new Error('first failed');
          },
        },
        good,
      ],
    });
    expect(result.adapterName).toBe('good');

    await expect(
      routeImagesForModel([image], {
        supportsVision: false,
        ctx,
        signal: new AbortController().signal,
        adapters: [
          {
            name: 'blank',
            async describe() {
              return '   ';
            },
          },
        ],
      }),
    ).rejects.toThrow('No image-understanding adapter could process an image.');

    await expect(
      routeImagesForModel([image], {
        supportsVision: false,
        ctx,
        signal: new AbortController().signal,
        adapters: [
          {
            name: 'broken',
            async describe() {
              throw new Error('details');
            },
          },
        ],
      }),
    ).rejects.toThrow('Last error: details');

    await expect(
      routeImagesForModel([image], {
        supportsVision: false,
        ctx,
        signal: new AbortController().signal,
        adapters: [
          {
            name: 'broken',
            async describe() {
              throw 'non-error';
            },
          },
        ],
      }),
    ).rejects.toThrow('No image-understanding adapter could process an image.');
  });

  it('uses the generic adapter label when an adapter has no runtime name', async () => {
    const result = await routeImagesForModel([image], {
      supportsVision: false,
      ctx,
      signal: new AbortController().signal,
      adapters: [
        {
          name: undefined,
          async describe() {
            return 'worked';
          },
        } as never,
      ],
    });
    expect((result.blocks[0] as { text: string }).text).toContain('via vision adapter');
  });

  it('discovers safe auto image-understanding tools as adapters', async () => {
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__describe_image',
      description: 'Analyze an image and return a textual description.',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'object' },
          prompt: { type: 'string' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        expect(input).toMatchObject({
          image: { type: 'base64', data: 'AAAA' },
        });
        return 'visible UI';
      },
    };
    registry.register(tool);

    const adapters = createToolVisionAdapters(registry);
    expect(adapters.map((a) => a.name)).toEqual(['mcp__vision__describe_image']);
    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('visible UI');
  });

  it('re-resolves adapter tools from the registry before execution', async () => {
    const registry = new ToolRegistry();
    const original: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__describe_image',
      description: 'Analyze an image and return a textual description.',
      inputSchema: { type: 'object', properties: { image: { type: 'object' } } },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'stale tool';
      },
    };
    const fresh: Tool<Record<string, unknown>, string> = {
      ...original,
      async execute() {
        return 'fresh tool';
      },
    };
    registry.register(original);
    const adapters = createToolVisionAdapters(registry);
    registry.unregister(original.name);
    registry.register(fresh);

    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('fresh tool');
  });

  it('rejects an adapter whose tool was unregistered', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'vision_read',
      description: 'Describe image',
      inputSchema: { type: 'object', properties: { image: { type: 'object' } } },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'unused';
      },
    });
    const adapters = createToolVisionAdapters(registry);
    registry.unregister('vision_read');
    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).rejects.toThrow('is no longer registered');
  });

  it('supports path-based MCP vision tools by writing a temporary image file', async () => {
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__zai_mcp_server__image_analysis',
      description: 'General-purpose image understanding.',
      inputSchema: {
        type: 'object',
        properties: {
          image_path: { type: 'string' },
          prompt: { type: 'string' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        expect(typeof input.image_path).toBe('string');
        expect(String(input.image_path)).toMatch(/wstack-vision-/);
        return 'zai saw a screenshot';
      },
    };
    registry.register(tool);

    const adapters = createToolVisionAdapters(registry);
    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('zai saw a screenshot');
  });

  it('uses a jpeg temp suffix and tolerates files already removed by the tool', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'vision_jpeg_path',
      description: 'Analyze image path',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        const file = String((input as Record<string, unknown>).path);
        expect(file).toMatch(/image\.jpg$/);
        await fs.unlink(file);
        await fs.rm(path.dirname(file), { recursive: true, force: true });
        return 'removed';
      },
    });
    const adapters = createToolVisionAdapters(registry);
    await expect(
      adapters[0]!.describe({
        image: {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
        },
        ctx,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('removed');
  });

  it('routes a base64 image through a `base64` schema property', async () => {
    const registry = new ToolRegistry();
    let receivedBase64 = '';
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__describe_b64',
      description: 'Analyze an image (base64 input).',
      inputSchema: {
        type: 'object',
        properties: { base64: { type: 'string' }, prompt: { type: 'string' } },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        receivedBase64 = String(input.base64);
        return 'b64-described';
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('b64-described');
    expect(receivedBase64).toBe('AAAA');
  });

  it('routes a base64 image through a `data` schema property', async () => {
    const registry = new ToolRegistry();
    let received = '';
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__analyse_data',
      description: 'Analyze an image (data input).',
      inputSchema: {
        type: 'object',
        properties: { data: { type: 'string' }, mediaType: { type: 'string' } },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        received = String(input.data);
        expect(input.mediaType).toBe('image/png');
        return 'data-described';
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('data-described');
    expect(received).toBe('AAAA');
  });

  it('routes a URL image through a `url` schema property', async () => {
    const registry = new ToolRegistry();
    const urlImage = {
      type: 'image' as const,
      source: { type: 'url' as const, url: 'https://example.com/a.png', media_type: 'image/png' },
    };
    let receivedUrl = '';
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__analyse_url',
      description: 'Analyze an image (url input).',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        receivedUrl = String(input.url);
        return 'url-described';
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    await expect(
      adapters[0]!.describe({ image: urlImage, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('url-described');
    expect(receivedUrl).toBe('https://example.com/a.png');
  });

  it('routes a URL through a generic image property and defaults its media type', async () => {
    const registry = new ToolRegistry();
    let captured: unknown;
    registry.register({
      name: 'vision_generic_image',
      description: 'Analyze image',
      inputSchema: { type: 'object', properties: { image: { type: 'object' } } },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        captured = (input as Record<string, unknown>).image;
        return 'ok';
      },
    });
    const adapters = createToolVisionAdapters(registry);
    await adapters[0]!.describe({
      image: {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/default.png' },
      } as never,
      ctx,
      signal: new AbortController().signal,
    });
    expect(captured).toEqual({ type: 'url', url: 'https://example.com/default.png' });
  });

  it('routes a URL image through `imageUrl` (camelCase variant)', async () => {
    const registry = new ToolRegistry();
    const urlImage = {
      type: 'image' as const,
      source: { type: 'url' as const, url: 'https://example.com/img.png', media_type: 'image/png' },
    };
    let receivedUrl = '';
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__analyse_imageurl',
      description: 'Analyze an image (imageUrl input).',
      inputSchema: {
        type: 'object',
        properties: { imageUrl: { type: 'string' } },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        receivedUrl = String(input.imageUrl);
        return 'imageUrl-described';
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    await expect(
      adapters[0]!.describe({ image: urlImage, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('imageUrl-described');
    expect(receivedUrl).toBe('https://example.com/img.png');
  });

  it('passes mediaType / mimeType / media_type when the tool schema declares them', async () => {
    const registry = new ToolRegistry();
    let captured: Record<string, unknown> = {};
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__media_type',
      description: 'Analyze an image with media type metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'object' },
          mediaType: { type: 'string' },
          mimeType: { type: 'string' },
          media_type: { type: 'string' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        captured = input;
        return 'mt';
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    await adapters[0]!.describe({ image, ctx, signal: new AbortController().signal });
    expect(captured.mediaType).toBe('image/png');
    expect(captured.mimeType).toBe('image/png');
    expect(captured.media_type).toBe('image/png');
  });

  it('passes the prompt under `query` and `instruction` aliases', async () => {
    const registry = new ToolRegistry();
    const captured: Record<string, unknown> = {};
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__describe_query',
      description: 'Analyze an image (query-aliased prompt).',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'object' },
          query: { type: 'string' },
          instruction: { type: 'string' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        captured.query = input.query;
        captured.instruction = input.instruction;
        return 'aliased';
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    await adapters[0]!.describe({
      image,
      ctx,
      prompt: 'OCR the image',
      signal: new AbortController().signal,
    });
    expect(captured.query).toBe('OCR the image');
    expect(captured.instruction).toBe('OCR the image');
  });

  it('handles tool results returned as an array of {text} blocks', async () => {
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, unknown> = {
      name: 'mcp__vision__describe_arr',
      description: 'Analyze an image and return blocks.',
      inputSchema: { type: 'object', properties: { image: { type: 'object' } } },
      permission: 'auto',
      mutating: false,
      async execute() {
        return [{ text: 'line1' }, 'line2', { other: 'ignored' }] as never;
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    const out = await adapters[0]!.describe({ image, ctx, signal: new AbortController().signal });
    expect(out).toContain('line1');
    expect(out).toContain('line2');
  });

  it('stringifies missing text values in array and object results', async () => {
    const makeAdapter = (result: unknown) => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'vision_result',
        description: 'Describe image',
        inputSchema: { type: 'object', properties: { image: { type: 'object' } } },
        permission: 'auto',
        mutating: false,
        async execute() {
          return result as never;
        },
      });
      return createToolVisionAdapters(registry)[0]!;
    };
    await expect(
      makeAdapter([{ text: undefined }]).describe({
        image,
        ctx,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('');
    await expect(
      makeAdapter({ text: undefined }).describe({
        image,
        ctx,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('');
  });

  it('handles tool results returned as a {text: ...} object', async () => {
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, unknown> = {
      name: 'mcp__vision__describe_obj',
      description: 'Analyze image, returns object with text.',
      inputSchema: { type: 'object', properties: { image: { type: 'object' } } },
      permission: 'auto',
      mutating: false,
      async execute() {
        return { text: 'object-text' } as never;
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    const out = await adapters[0]!.describe({ image, ctx, signal: new AbortController().signal });
    expect(out).toBe('object-text');
  });

  it('supports MiniMax-style understand_image tools that accept image_url paths', async () => {
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__MiniMax__understand_image',
      description: 'Analyze and understand image content with AI vision capabilities.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          image_url: { type: 'string' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        expect(typeof input.image_url).toBe('string');
        expect(String(input.image_url)).toMatch(/wstack-vision-/);
        expect(input.prompt).toContain('Describe this image');
        return 'minimax saw the UI';
      },
    };
    registry.register(tool);

    const adapters = createToolVisionAdapters(registry);
    expect(adapters.map((a) => a.name)).toEqual(['mcp__MiniMax__understand_image']);
    await expect(
      adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('minimax saw the UI');
  });

  it('routes a URL image through `image_url` (snake_case variant)', async () => {
    const registry = new ToolRegistry();
    const urlImage = {
      type: 'image' as const,
      source: {
        type: 'url' as const,
        url: 'https://example.com/snake.png',
        media_type: 'image/png',
      },
    };
    let received = '';
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__url_snake',
      description: 'Analyze an image (image_url input).',
      inputSchema: {
        type: 'object',
        properties: { image_url: { type: 'string' } },
      },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        received = String(input.image_url);
        return 'snake-described';
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    await expect(
      adapters[0]!.describe({ image: urlImage, ctx, signal: new AbortController().signal }),
    ).resolves.toBe('snake-described');
    expect(received).toBe('https://example.com/snake.png');
  });

  it('rejects schema that has no recognized image input property', async () => {
    // A tool whose schema lacks every recognized image property —
    // buildToolPayload returns null, describe() throws.
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, string> = {
      name: 'mcp__vision__describe_no_input',
      description: 'Analyze an image with no input slot.',
      inputSchema: {
        type: 'object',
        // No image / base64 / data / url / image_url / imageUrl / image_path
        properties: { only_prompt: { type: 'string' } },
      },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'should-never-be-called';
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    // No adapter is even built since schema is unsupported.
    expect(adapters).toHaveLength(0);
  });

  it('filters unsafe, generative, unrelated, and malformed tool declarations', () => {
    const registry = new ToolRegistry();
    const base = {
      description: 'Analyze image',
      inputSchema: { type: 'object', properties: { image: { type: 'object' } } },
      permission: 'auto' as const,
      mutating: false,
      async execute() {
        return 'unused';
      },
    };
    registry.register({ ...base, name: 'manual_vision', permission: 'confirm' });
    registry.register({ ...base, name: 'mutating_vision', mutating: true });
    registry.register({ ...base, name: 'generate_image' });
    registry.register({
      ...base,
      name: 'plain_reader',
      description: undefined,
      usageHint: undefined,
    } as never);

    expect(createToolVisionAdapters(registry)).toEqual([]);

    const malformedRegistry = {
      list: () => [
        { ...base, name: 'vision_missing_schema', inputSchema: undefined },
        {
          ...base,
          name: 'vision_bad_properties',
          inputSchema: { type: 'object', properties: 'bad' },
        },
      ],
      get: () => undefined,
    };
    expect(createToolVisionAdapters(malformedRegistry as never)).toEqual([]);
  });

  it('stringifies a non-string non-array non-text tool result via JSON.stringify', async () => {
    const registry = new ToolRegistry();
    const tool: Tool<Record<string, unknown>, unknown> = {
      name: 'mcp__vision__describe_json',
      description: 'Analyze image, returns arbitrary object.',
      inputSchema: { type: 'object', properties: { image: { type: 'object' } } },
      permission: 'auto',
      mutating: false,
      async execute() {
        // Object without a `text` property — should fall through to JSON.stringify
        return { score: 42, label: 'cat' } as never;
      },
    };
    registry.register(tool);
    const adapters = createToolVisionAdapters(registry);
    const out = await adapters[0]!.describe({ image, ctx, signal: new AbortController().signal });
    expect(out).toBe(JSON.stringify({ score: 42, label: 'cat' }));
  });

  describe('URL SSRF guard', () => {
    // Vision adapters forward image URLs straight to the underlying tool,
    // which typically fetches them server-side. Without an explicit check,
    // a malicious or malformed URL like http://169.254.169.254/... would
    // turn image analysis into an SSRF vector. The guard must run BEFORE
    // the URL is handed to the adapter — same model as fetch.ts.

    function urlTool(
      name: string,
      key: 'url' | 'image_url' | 'imageUrl',
    ): Tool<Record<string, unknown>, string> {
      return {
        name,
        description: 'Analyze an image (url input).',
        inputSchema: { type: 'object', properties: { [key]: { type: 'string' } } },
        permission: 'auto',
        mutating: false,
        async execute() {
          return 'should-not-be-called';
        },
      };
    }

    function urlImage(url: string) {
      return {
        type: 'image' as const,
        source: { type: 'url' as const, url, media_type: 'image/png' },
      };
    }

    it('blocks a localhost URL', async () => {
      const registry = new ToolRegistry();
      registry.register(urlTool('mcp__vision__url_localhost', 'url'));
      const adapters = createToolVisionAdapters(registry);
      let caught: unknown;
      try {
        await adapters[0]!.describe({
          image: urlImage('http://localhost/a.png'),
          ctx,
          signal: new AbortController().signal,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(VisionUrlBlockedError);
      expect((caught as VisionUrlBlockedError).url).toBe('http://localhost/a.png');
    });

    it('blocks a 127.0.0.1 URL', async () => {
      const registry = new ToolRegistry();
      registry.register(urlTool('mcp__vision__url_loopback', 'image_url'));
      const adapters = createToolVisionAdapters(registry);
      await expect(
        adapters[0]!.describe({
          image: urlImage('http://127.0.0.1:8080/a.png'),
          ctx,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(VisionUrlBlockedError);
    });

    it('blocks the cloud metadata endpoint (169.254.169.254)', async () => {
      const registry = new ToolRegistry();
      registry.register(urlTool('mcp__vision__url_imds', 'imageUrl'));
      const adapters = createToolVisionAdapters(registry);
      await expect(
        adapters[0]!.describe({
          image: urlImage('http://169.254.169.254/latest/meta-data/'),
          ctx,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(VisionUrlBlockedError);
    });

    it('reports malformed adapter URLs as unresolvable', async () => {
      const registry = new ToolRegistry();
      registry.register(urlTool('mcp__vision__url_malformed', 'url'));
      const adapters = createToolVisionAdapters(registry);
      await expect(
        adapters[0]!.describe({
          image: urlImage('not a url'),
          ctx,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/unresolvable host/);
    });

    it('allows a public URL (no false positive on a clean target)', async () => {
      const registry = new ToolRegistry();
      registry.register(urlTool('mcp__vision__url_public', 'url'));
      const adapters = createToolVisionAdapters(registry);
      const out = await adapters[0]!.describe({
        image: urlImage('https://example.com/a.png'),
        ctx,
        signal: new AbortController().signal,
      });
      expect(out).toBe('should-not-be-called');
    });

    it('does NOT validate URL inputs when the image is base64', async () => {
      // base64 images have no URL — the SSRF guard is a no-op, the tool
      // receives the bytes directly. This test guards against a regression
      // where someone wires the guard around the wrong field.
      const registry = new ToolRegistry();
      registry.register(urlTool('mcp__vision__b64_should_run', 'url'));
      const adapters = createToolVisionAdapters(registry);
      // Note: this tool's schema is `url`, but the image is base64 — so
      // buildToolPayload can't route it through `url` and returns null,
      // which means the adapter's describe() throws "does not expose a
      // supported image input schema". That throw is NOT the SSRF guard.
      await expect(
        adapters[0]!.describe({ image, ctx, signal: new AbortController().signal }),
      ).rejects.toThrow(/does not expose a supported image input schema/);
    });
  });
});

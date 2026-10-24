import type { DocumentBlock, Message, Request } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { convertMessages } from '../src/ai-gateway.js';
import { CatalogRoutedProvider } from '../src/catalog-routed.js';
import { GoogleProvider } from '../src/google.js';
import { OpenAIProvider } from '../src/openai.js';
import { OpenAIResponsesProvider } from '../src/openai-responses.js';
import { anthropicWireFormat } from '../src/presets/anthropic.js';
import { googleWireFormat } from '../src/presets/google.js';
import { messagesToOpenAI } from '../src/tool-format/to-openai.js';
import { messagesToResponsesInput } from '../src/tool-format/to-responses.js';

const PDF = 'JVBERi0xLjQK';
const pdf: DocumentBlock = {
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: PDF },
  name: 'spec.pdf',
  text: 'the text',
  pages: 2,
};
const messages: Message[] = [{ role: 'user', content: [pdf, { type: 'text', text: 'summarize' }] }];
const ctx = {
  capabilities: anthropicWireFormat.capabilities,
  providerId: 'anthropic',
};

describe('native document parts per wire', () => {
  it('Anthropic sends a document block titled with the file name', () => {
    const body = anthropicWireFormat.buildBody(
      { model: 'm', maxTokens: 10, messages } as Request,
      ctx,
    ) as { messages: { content: unknown[] }[] };
    expect(body.messages[0]?.content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF },
      title: 'spec.pdf',
    });
  });

  it('Gemini sends the PDF as inline data', () => {
    const body = googleWireFormat.buildBody({ model: 'gemini', messages } as Request, {
      capabilities: googleWireFormat.capabilities,
      providerId: 'google',
    }) as { contents: { parts: unknown[] }[] };
    expect(body.contents[0]?.parts).toContainEqual({
      inlineData: { mimeType: 'application/pdf', data: PDF },
    });
  });

  it('OpenAI chat sends a file part with a data URL', () => {
    const [user] = messagesToOpenAI(undefined, messages);
    expect(user?.content).toContainEqual({
      type: 'file',
      file: { filename: 'spec.pdf', file_data: `data:application/pdf;base64,${PDF}` },
    });
  });

  it('OpenAI Responses sends an input_file', () => {
    const [user] = messagesToResponsesInput(messages) as { content: unknown[] }[];
    expect(user?.content).toContainEqual({
      type: 'input_file',
      filename: 'spec.pdf',
      file_data: `data:application/pdf;base64,${PDF}`,
    });
  });

  it('the AI SDK gateway sends a file part for the user', () => {
    const [user] = convertMessages(messages) as { content: unknown[] }[];
    expect(user?.content).toContainEqual({
      type: 'file',
      mediaType: 'application/pdf',
      data: PDF,
      filename: 'spec.pdf',
    });
  });
});

function jsonFetch(
  body: unknown,
  seen: { url: string; body: unknown; headers: Record<string, string> }[],
) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
    });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as never as typeof fetch;
}

describe('generateImage', () => {
  it('OpenAI posts to the images API next to the chat endpoint and reads base64', async () => {
    const seen: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const provider = new OpenAIProvider({
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl: jsonFetch(
        {
          data: [{ b64_json: 'AAAA', revised_prompt: 'a red cube, studio light' }],
          output_format: 'webp',
        },
        seen,
      ),
    });
    const out = await provider.generateImage(
      { model: 'gpt-image-1', prompt: 'a red cube', size: '1024x1024', count: 9 },
      { signal: new AbortController().signal },
    );
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/images/generations');
    expect(seen[0]?.headers['authorization']).toBe('Bearer k');
    // gpt-image refuses response_format; the count is capped.
    expect(seen[0]?.body).toEqual({
      model: 'gpt-image-1',
      prompt: 'a red cube',
      n: 4,
      size: '1024x1024',
    });
    expect(out).toEqual({
      images: [{ data: 'AAAA', mediaType: 'image/webp' }],
      text: 'a red cube, studio light',
    });
  });

  it('asks DALL-E for base64 instead of a short-lived URL', async () => {
    const seen: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const provider = new OpenAIResponsesProvider({
      id: 'gw',
      apiKey: 'k',
      baseUrl: 'https://gw.example/v1/responses',
      fetchImpl: jsonFetch({ data: [{ b64_json: 'BBBB' }] }, seen),
    });
    await provider.generateImage(
      { model: 'dall-e-3', prompt: 'p' },
      { signal: new AbortController().signal },
    );
    expect(seen[0]?.url).toBe('https://gw.example/v1/images/generations');
    expect(seen[0]?.body).toMatchObject({ response_format: 'b64_json', n: 1 });
  });

  it('turns an HTTP failure into the provider error', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: 'no such model' } }), {
          status: 404,
        })) as never as typeof fetch,
    });
    await expect(
      provider.generateImage({ model: 'x', prompt: 'p' }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('Gemini calls generateContent once per image and collects inline images and text', async () => {
    const seen: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const provider = new GoogleProvider({
      apiKey: 'g',
      fetchImpl: jsonFetch(
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'Here it is.' },
                  { inlineData: { mimeType: 'image/png', data: 'CCCC' } },
                ],
              },
            },
          ],
        },
        seen,
      ),
    });
    const out = await provider.generateImage(
      { model: 'gemini-2.5-flash-image', prompt: 'p', size: '1536x1024', count: 2 },
      { signal: new AbortController().signal },
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    );
    expect(seen[0]?.headers['x-goog-api-key']).toBe('g');
    expect(seen[0]?.body).toMatchObject({
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '3:2' },
      },
    });
    expect(out.images).toHaveLength(2);
    expect(out.text).toBe('Here it is.\nHere it is.');
  });

  it('Imagen models go through predict with a sample count', async () => {
    const seen: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const provider = new GoogleProvider({
      apiKey: 'g',
      fetchImpl: jsonFetch(
        { predictions: [{ bytesBase64Encoded: 'DDDD', mimeType: 'image/jpeg' }] },
        seen,
      ),
    });
    const out = await provider.generateImage(
      { model: 'imagen-4.0-generate-001', prompt: 'p', count: 3 },
      { signal: new AbortController().signal },
    );
    expect(seen[0]?.url).toMatch(/imagen-4\.0-generate-001:predict$/);
    expect(seen[0]?.body).toEqual({ instances: [{ prompt: 'p' }], parameters: { sampleCount: 3 } });
    expect(out.images).toEqual([{ data: 'DDDD', mediaType: 'image/jpeg' }]);
  });

  it('a catalog-routed provider forwards to the wire that serves the model', async () => {
    const seen: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const provider = new CatalogRoutedProvider({
      id: 'mixed',
      apiKey: 'k',
      defaultNpm: '@ai-sdk/openai-compatible',
      baseUrl: 'https://mixed.example/v1',
      fetchImpl: jsonFetch({ data: [{ b64_json: 'EEEE' }] }, seen),
      models: [{ id: 'img', name: 'Img' }],
    });
    const out = await provider.generateImage(
      { model: 'img', prompt: 'p' },
      { signal: new AbortController().signal },
    );
    expect(seen[0]?.url).toBe('https://mixed.example/v1/images/generations');
    expect(out.images[0]?.data).toBe('EEEE');
  });

  it('a catalog-routed Anthropic model says it cannot draw', () => {
    const provider = new CatalogRoutedProvider({
      id: 'mixed',
      apiKey: 'k',
      defaultNpm: '@ai-sdk/anthropic',
      baseUrl: 'https://mixed.example/v1',
      models: [{ id: 'claude', name: 'Claude' }],
    });
    expect(() =>
      provider.generateImage(
        { model: 'claude', prompt: 'p' },
        { signal: new AbortController().signal },
      ),
    ).toThrow(/no image API/);
  });
});

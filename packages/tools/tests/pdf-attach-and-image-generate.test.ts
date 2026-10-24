import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ImageGenerationRequest,
  Provider,
  ResolvedProvider,
} from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createImageGenerateTool,
  type ImageTarget,
  imageTargetsFromCatalog,
} from '../src/image-generate.js';
import { PDF_ATTACH_MAX_PAGES, preparePdfAttachment } from '../src/pdf-text.js';
import { makePdf } from './pdf-fixture.js';

describe('preparePdfAttachment', () => {
  it('makes a document block with the file and its page-marked text', async () => {
    const bytes = makePdf(['First', 'Second']);
    const out = await preparePdfAttachment(bytes, 'spec.pdf');
    expect(out.kind).toBe('document');
    if (out.kind !== 'document') return;
    expect(out.block.pages).toBe(2);
    expect(out.block.text).toBe('--- page 1 ---\nFirst\n\n--- page 2 ---\nSecond');
    expect(Buffer.from(out.block.source.data, 'base64').equals(bytes)).toBe(true);
  });

  it('falls back to the first pages as text past the page cap, and says so', async () => {
    const pages = Array.from({ length: PDF_ATTACH_MAX_PAGES + 1 }, (_, i) => `P${i + 1}`);
    const out = await preparePdfAttachment(makePdf(pages), 'long.pdf');
    expect(out.kind).toBe('text');
    if (out.kind !== 'text') return;
    expect(out.pages).toBe(PDF_ATTACH_MAX_PAGES + 1);
    expect(out.text).toContain('Only the text of pages 1-20 of 101 is attached');
    expect(out.text).toContain('--- page 20 ---\nP20');
    expect(out.text).not.toContain('--- page 21 ---');
  });

  it('rejects a file that is not a PDF', async () => {
    await expect(preparePdfAttachment(Buffer.from('not a pdf'), 'x.pdf')).rejects.toThrow();
  });
});

describe('imageTargetsFromCatalog', () => {
  const catalog = new Map<string, ResolvedProvider>([
    [
      'openai',
      {
        id: 'openai',
        models: [
          {
            id: 'gpt-5.1',
            modalities: { input: ['text'], output: ['text', 'image'] },
            release_date: '2026-01-01',
          },
          {
            id: 'gpt-image-1',
            modalities: { input: ['text'], output: ['image'] },
            release_date: '2025-04-01',
          },
          {
            id: 'gpt-image-2',
            modalities: { input: ['text'], output: ['image'] },
            release_date: '2026-03-01',
          },
        ],
      } as unknown as ResolvedProvider,
    ],
    [
      'deepseek',
      {
        id: 'deepseek',
        models: [{ id: 'chat', modalities: { output: ['text'] } }],
      } as unknown as ResolvedProvider,
    ],
  ]);

  it('picks the newest dedicated image model per provider, in the given order', () => {
    expect(imageTargetsFromCatalog(['deepseek', 'openai', 'missing'], catalog)).toEqual([
      { provider: 'openai', model: 'gpt-image-2' },
    ]);
  });
});

describe('image_generate', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-gen-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const ctx = () => ({ cwd: dir, projectRoot: dir, workingDir: dir, meta: {} }) as never;
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

  function drawingProvider(
    id: string,
    seen: ImageGenerationRequest[],
    images = [{ data: PNG, mediaType: 'image/png' }],
  ): Provider {
    return {
      id,
      capabilities: {} as Provider['capabilities'],
      stream: () => {
        throw new Error('unused');
      },
      complete: () => {
        throw new Error('unused');
      },
      // `this` must survive the tool handing the method around.
      async generateImage(this: Provider, req: ImageGenerationRequest) {
        expect(this.id).toBe(id);
        seen.push(req);
        return { images: images.slice(0, req.count ?? 1), text: 'revised' };
      },
    };
  }

  function tool(targets: ImageTarget[], providers: Record<string, Provider>) {
    return createImageGenerateTool({
      buildProvider: (id) => {
        const p = providers[id];
        if (!p) throw new Error(`no credentials for ${id}`);
        return p;
      },
      listTargets: () => targets,
    });
  }

  it('writes the image into the project and reports what it did', async () => {
    const seen: ImageGenerationRequest[] = [];
    const t = tool([{ provider: 'openai', model: 'gpt-image-2' }], {
      openai: drawingProvider('openai', seen),
    });
    const out = await t.execute({ prompt: 'a cube', path: 'assets/cube.png' }, ctx(), {
      signal: new AbortController().signal,
    });
    expect(seen).toEqual([{ model: 'gpt-image-2', prompt: 'a cube', size: undefined, count: 1 }]);
    expect(out).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-2',
      files: [{ path: 'assets/cube.png', bytes: 8, mediaType: 'image/png' }],
      text: 'revised',
    });
    expect((await fs.readFile(path.join(dir, 'assets/cube.png'))).toString('hex')).toBe(
      '89504e470d0a1a0a',
    );
  });

  it('numbers extra images and follows the returned format', async () => {
    const seen: ImageGenerationRequest[] = [];
    const jpeg = { data: PNG, mediaType: 'image/jpeg' };
    const t = tool([{ provider: 'google', model: 'gemini-image' }], {
      google: drawingProvider('google', seen, [jpeg, jpeg]),
    });
    const out = await t.execute({ prompt: 'p', path: 'out/pic.png', count: 2 }, ctx(), {
      signal: new AbortController().signal,
    });
    expect(out.files.map((f) => f.path)).toEqual(['out/pic.jpg', 'out/pic-2.jpg']);
    expect(out.note).toContain('saved as out/pic.jpg');

    const kept = await t.execute({ prompt: 'p', path: 'out/photo.jpeg' }, ctx(), {
      signal: new AbortController().signal,
    });
    expect(kept.files[0]?.path).toBe('out/photo.jpeg');
    expect(kept.note).toBeUndefined();
  });

  it('skips providers it cannot build or that cannot draw, and names why when none can', async () => {
    const seen: ImageGenerationRequest[] = [];
    const { generateImage: _draws, ...chatOnly } = drawingProvider('anthropic', seen);
    const t = tool(
      [
        { provider: 'nokey', model: 'm' },
        { provider: 'anthropic', model: 'm' },
      ],
      { anthropic: chatOnly },
    );
    await expect(
      t.execute({ prompt: 'p', path: 'x.png' }, ctx(), { signal: new AbortController().signal }),
    ).rejects.toThrow(
      /nokey: no credentials for nokey; anthropic: its API has no image generation/,
    );

    const none = tool([], {});
    await expect(
      none.execute({ prompt: 'p', path: 'x.png' }, ctx(), { signal: new AbortController().signal }),
    ).rejects.toThrow(/lists an image model/);
  });

  it('moves past a provider whose wire has no images endpoint, unless it was pinned', async () => {
    const seen: ImageGenerationRequest[] = [];
    const noEndpoint: Provider = {
      ...drawingProvider('gateway', []),
      async generateImage() {
        throw Object.assign(new Error('gateway HTTP 404'), { status: 404 });
      },
    };
    const t = tool(
      [
        { provider: 'gateway', model: 'wan-image' },
        { provider: 'openai', model: 'gpt-image-2' },
      ],
      { gateway: noEndpoint, openai: drawingProvider('openai', seen) },
    );
    const out = await t.execute({ prompt: 'p', path: 'fallthrough.png' }, ctx(), {
      signal: new AbortController().signal,
    });
    expect(out).toMatchObject({ provider: 'openai', model: 'gpt-image-2' });

    await expect(
      t.execute({ prompt: 'p', path: 'pinned.png', provider: 'gateway' }, ctx(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/gateway\/wan-image failed: gateway HTTP 404/);
  });

  it('does not move on from a real failure such as a refused key', async () => {
    const refused: Provider = {
      ...drawingProvider('openai', []),
      async generateImage() {
        throw Object.assign(new Error('openai HTTP 401'), { status: 401 });
      },
    };
    const t = tool(
      [
        { provider: 'openai', model: 'gpt-image-2' },
        { provider: 'google', model: 'imagen-4' },
      ],
      { openai: refused, google: drawingProvider('google', []) },
    );
    await expect(
      t.execute({ prompt: 'p', path: 'x.png' }, ctx(), { signal: new AbortController().signal }),
    ).rejects.toThrow(/openai\/gpt-image-2 failed: openai HTTP 401/);
  });

  it('honours a pinned provider and model', async () => {
    const seen: ImageGenerationRequest[] = [];
    const t = tool([{ provider: 'openai', model: 'gpt-image-2' }], {
      openai: drawingProvider('openai', []),
      google: drawingProvider('google', seen),
    });
    const out = await t.execute(
      { prompt: 'p', path: 'g.png', provider: 'google', model: 'imagen-4' },
      ctx(),
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({ provider: 'google', model: 'imagen-4' });
    expect(seen[0]?.model).toBe('imagen-4');
  });

  it('refuses a path outside the project before spending a request', async () => {
    const seen: ImageGenerationRequest[] = [];
    const t = tool([{ provider: 'openai', model: 'm' }], {
      openai: drawingProvider('openai', seen),
    });
    await expect(
      t.execute({ prompt: 'p', path: '../escape.png' }, ctx(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('reports a model that answered without an image', async () => {
    const t = tool([{ provider: 'openai', model: 'm' }], {
      openai: drawingProvider('openai', [], []),
    });
    await expect(
      t.execute({ prompt: 'p', path: 'x.png' }, ctx(), { signal: new AbortController().signal }),
    ).rejects.toThrow(/returned no image \(it said: revised\)/);
  });
});

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  GeneratedImage,
  ImageGenerationResult,
  ModelsDevModel,
  Provider,
  ResolvedProvider,
  Tool,
} from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { atomicWrite, toErrorMessage } from '@wrongstack/core/utils';
import { safeResolveReal } from './_util.js';

export interface ImageGenerateInput {
  prompt: string;
  /** Project-relative file to write; `-2`, `-3`… are added for more images. */
  path: string;
  size?: string | undefined;
  count?: number | undefined;
  /** Pin a configured provider; otherwise the first one with an image model is used. */
  provider?: string | undefined;
  /** Pin an image model; needs `provider` unless the default provider serves it. */
  model?: string | undefined;
}

export interface ImageGenerateOutput {
  provider: string;
  model: string;
  files: { path: string; bytes: number; mediaType: string }[];
  /** Text the model returned alongside the images. */
  text?: string | undefined;
  note?: string | undefined;
}

/** A provider and one of its image models, in the order they are tried. */
export interface ImageTarget {
  provider: string;
  model: string;
}

export interface ImageGenerateToolDeps {
  buildProvider(providerId: string): Provider | Promise<Provider>;
  /** Candidate targets, best first; see {@link imageTargetsFromCatalog}. */
  listTargets(): ImageTarget[] | Promise<ImageTarget[]>;
}

const MAX_IMAGES = 4;
const EXT_BY_MEDIA: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const MEDIA_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Image models of the configured providers, from the catalog: models whose
 * output modalities include `image`, dedicated image models (no text output,
 * or an image-named id) before chat models that can also draw, newest first
 * within each. Providers keep the order given, so the session provider is
 * tried first.
 */
export function imageTargetsFromCatalog(
  providerIds: readonly string[],
  catalog: ReadonlyMap<string, ResolvedProvider>,
): ImageTarget[] {
  const out: ImageTarget[] = [];
  for (const id of providerIds) {
    const models = (catalog.get(id)?.models ?? []).filter((m) =>
      m.modalities?.output?.includes('image'),
    );
    const dedicated = (m: ModelsDevModel) =>
      !m.modalities?.output?.includes('text') || /image|imagen|dall-e/i.test(m.id) ? 0 : 1;
    models.sort(
      (a, b) =>
        dedicated(a) - dedicated(b) || (b.release_date ?? '').localeCompare(a.release_date ?? ''),
    );
    const best = models[0];
    if (best) out.push({ provider: id, model: best.id });
  }
  return out;
}

export function createImageGenerateTool(
  deps: ImageGenerateToolDeps,
): Tool<ImageGenerateInput, ImageGenerateOutput> {
  return {
    name: 'image_generate',
    category: 'Media',
    description:
      'Generate an image from a text prompt with an image model of a configured provider ' +
      '(OpenAI images, Gemini/Imagen) and save it into the project.',
    usageHint:
      'Give a concrete `prompt` and a project-relative `path` (the extension follows the returned ' +
      'format). `count` up to 4 writes `name-2.png`, `name-3.png`… Without `provider`/`model` the ' +
      'first configured provider whose catalog lists an image model is used.',
    permission: 'confirm',
    subjectKey: 'path',
    mutating: true,
    timeoutMs: 180_000,
    maxOutputBytes: 8_192,
    capabilities: ['fs.write', 'net.outbound'],
    icon: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw.' },
        path: {
          type: 'string',
          description: 'Project-relative output file, e.g. assets/hero.png.',
        },
        size: {
          type: 'string',
          description: 'e.g. 1024x1024 or 1536x1024; provider default when omitted.',
        },
        count: { type: 'number', description: 'Images to generate, 1-4. Default 1.' },
        provider: { type: 'string', description: 'Configured provider id to use.' },
        model: { type: 'string', description: 'Image model id to use.' },
      },
      required: ['prompt', 'path'],
    },
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal ?? new AbortController().signal;
      return generate(input, ctx, signal, deps);
    },
  };
}

async function generate(
  input: ImageGenerateInput,
  ctx: Context,
  signal: AbortSignal,
  deps: ImageGenerateToolDeps,
): Promise<ImageGenerateOutput> {
  if (!input?.prompt?.trim()) {
    throw new ToolValidationError({
      message: 'image_generate: prompt is required',
      field: 'prompt',
    });
  }
  if (!input.path?.trim()) {
    throw new ToolValidationError({ message: 'image_generate: path is required', field: 'path' });
  }
  const count = Math.min(MAX_IMAGES, Math.max(1, Math.floor(input.count ?? 1)));
  // Resolved before any tokens are spent: a path outside the project fails here.
  await safeResolveReal(input.path, ctx);

  const { result, target } = await drawWithFirstUsable(input, count, signal, deps);

  const files: ImageGenerateOutput['files'] = [];
  const renamed: string[] = [];
  for (const [i, image] of result.images.entries()) {
    const rel = outputPath(input.path, image, i);
    if (path.extname(rel) !== path.extname(input.path) && i === 0) renamed.push(rel);
    const abs = await safeResolveReal(rel, ctx);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const bytes = Buffer.from(image.data, 'base64');
    await atomicWrite(abs, bytes);
    files.push({ path: rel, bytes: bytes.byteLength, mediaType: image.mediaType });
  }
  return {
    provider: target.provider,
    model: target.model,
    files,
    ...(result.text ? { text: result.text.slice(0, 2_000) } : {}),
    ...(renamed.length > 0
      ? { note: `The model returned ${result.images[0]?.mediaType}; saved as ${renamed[0]}.` }
      : {}),
  };
}

/** The file for the i-th image: the extension follows the returned format. */
function outputPath(requested: string, image: GeneratedImage, index: number): string {
  const mediaType = image.mediaType.toLowerCase();
  const ext = path.extname(requested);
  const stem = ext ? requested.slice(0, -ext.length) : requested;
  // Keep the caller's extension when it already names the returned format.
  const keep = ext && MEDIA_BY_EXT[ext.toLowerCase()] === mediaType;
  const finalExt = keep ? ext : (EXT_BY_MEDIA[mediaType] ?? (ext || '.png'));
  return `${stem}${index === 0 ? '' : `-${index + 1}`}${finalExt}`;
}

/**
 * Try the candidate targets in order. A provider that cannot be built, has no
 * image API, or answers 404/405 (the wire has no images endpoint, as on many
 * compatible gateways) is skipped with its reason when the target was picked
 * automatically; any other failure, or any failure of a pinned provider, is
 * the answer.
 */
async function drawWithFirstUsable(
  input: ImageGenerateInput,
  count: number,
  signal: AbortSignal,
  deps: ImageGenerateToolDeps,
): Promise<{ result: ImageGenerationResult; target: ImageTarget }> {
  const targets = await deps.listTargets();
  const pinned = input.provider !== undefined;
  const candidates: ImageTarget[] = pinned
    ? [
        {
          provider: input.provider as string,
          model: input.model ?? targetModel(targets, input.provider as string),
        },
      ]
    : input.model
      ? targets.map((t) => ({ provider: t.provider, model: input.model as string }))
      : targets;
  const skipped: string[] = [];
  for (const target of candidates) {
    if (!target.model) {
      skipped.push(`${target.provider}: no image model in the catalog; pass \`model\``);
      continue;
    }
    let provider: Provider;
    try {
      provider = await deps.buildProvider(target.provider);
    } catch (err) {
      skipped.push(`${target.provider}: ${toErrorMessage(err)}`);
      continue;
    }
    if (!provider.generateImage) {
      skipped.push(`${target.provider}: its API has no image generation`);
      continue;
    }
    let result: ImageGenerationResult;
    try {
      result = await provider.generateImage(
        { model: target.model, prompt: input.prompt, size: input.size, count },
        { signal },
      );
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (!pinned && (status === 404 || status === 405)) {
        skipped.push(`${target.provider}/${target.model}: no images endpoint (HTTP ${status})`);
        continue;
      }
      throw new Error(
        `image_generate: ${target.provider}/${target.model} failed: ${toErrorMessage(err)}`,
      );
    }
    if (result.images.length === 0) {
      throw new Error(
        `image_generate: ${target.provider}/${target.model} returned no image` +
          (result.text ? ` (it said: ${result.text.slice(0, 300)})` : ''),
      );
    }
    return { result, target };
  }
  throw new Error(
    skipped.length > 0
      ? `image_generate: no usable image provider (${skipped.join('; ')}).`
      : 'image_generate: none of the configured providers lists an image model in the catalog. ' +
          'Configure an OpenAI or Gemini provider, or pass `provider` and `model`.',
  );
}

function targetModel(targets: readonly ImageTarget[], provider: string): string {
  return targets.find((t) => t.provider === provider)?.model ?? '';
}

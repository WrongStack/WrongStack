import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { ContentBlock, ImageBlock, Tool } from '@wrongstack/core/types';
import { assertNotPrivateHost } from '@wrongstack/core/utils';

export interface VisionAdapterInput {
  image: ImageBlock;
  prompt?: string | undefined;
  ctx: Context;
  signal: AbortSignal;
}

export interface VisionAdapter {
  name: string;
  describe(input: VisionAdapterInput): Promise<string>;
}

export type VisionAdapters =
  | readonly VisionAdapter[]
  | (() => readonly VisionAdapter[] | Promise<readonly VisionAdapter[]>);

export interface VisionRoutingOptions {
  supportsVision: boolean;
  adapters?: VisionAdapters | undefined;
  ctx: Context;
  signal: AbortSignal;
  prompt?: string | undefined;
  providerId?: string | undefined;
  model?: string | undefined;
}

export interface VisionRoutingResult {
  blocks: ContentBlock[];
  route: 'native' | 'adapter' | 'none';
  convertedImages: number;
  adapterName?: string | undefined;
}

export class ImageInputUnsupportedError extends Error {
  constructor(opts: {
    providerId?: string | undefined;
    model?: string | undefined;
    imageCount: number;
  }) {
    const target = [opts.providerId, opts.model].filter(Boolean).join('/') || 'current model';
    super(
      `${target} does not support image input, and no image-understanding adapter is available for ${opts.imageCount} image${opts.imageCount === 1 ? '' : 's'}. Switch to a vision model or enable an MCP/tool adapter that can describe images.`,
    );
    this.name = 'ImageInputUnsupportedError';
  }
}

/**
 * Thrown when an image URL targets a private / loopback / IMDS address.
 * Vision adapters forward URLs straight to the underlying tool, so without
 * this check a malicious (or accidentally-malformed) `image.source.url`
 * could turn image analysis into an SSRF vector hitting localhost, RFC1918
 * ranges, or the cloud metadata endpoint.
 *
 * Carries the rejected URL so callers can log / surface it without parsing
 * the message.
 */
export class VisionUrlBlockedError extends Error {
  readonly url: string;

  constructor(opts: { url: string; reason: string }) {
    super(`vision: blocked unsafe image URL "${opts.url}" (${opts.reason})`);
    this.name = 'VisionUrlBlockedError';
    this.url = opts.url;
  }
}

export async function routeImagesForModel(
  blocks: ContentBlock[],
  opts: VisionRoutingOptions,
): Promise<VisionRoutingResult> {
  const images = blocks.filter((b): b is ImageBlock => b.type === 'image');
  if (images.length === 0) {
    return { blocks, route: 'none', convertedImages: 0 };
  }
  if (opts.supportsVision) {
    // Native vision providers typically fetch image URLs server-side, so
    // enforce the same SSRF guard used for adapter routes.
    for (const img of images) {
      if (img.source.type === 'url' && img.source.url) {
        try {
          await assertNotPrivateHost(new URL(img.source.url).hostname);
        } catch (err) {
          const reason =
            err instanceof Error && err.message.startsWith('fetch:')
              ? err.message.slice('fetch:'.length).trim()
              : 'unresolvable host';
          throw new VisionUrlBlockedError({ url: img.source.url, reason });
        }
      }
    }
    return { blocks, route: 'native', convertedImages: 0 };
  }

  const adapters = await resolveAdapters(opts.adapters);
  if (adapters.length === 0) {
    throw new ImageInputUnsupportedError({
      providerId: opts.providerId,
      model: opts.model,
      imageCount: images.length,
    });
  }

  const out: ContentBlock[] = [];
  let convertedImages = 0;
  let adapterName: string | undefined;
  for (const block of blocks) {
    if (block.type !== 'image') {
      out.push(block);
      continue;
    }
    let description: string | undefined;
    // Scoped per image: an error raised while describing an earlier image must
    // not be reported as the reason this one could not be described.
    let lastErr: unknown;
    for (const adapter of adapters) {
      try {
        const candidate = await adapter.describe({
          image: block,
          prompt: opts.prompt,
          ctx: opts.ctx,
          signal: opts.signal,
        });
        // A blank answer is a failure, not a result — fall through to the next
        // adapter instead of aborting the whole route on it.
        if (!candidate?.trim()) continue;
        description = candidate;
        adapterName = adapter.name;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!description?.trim()) {
      throw new Error(
        `No image-understanding adapter could process an image.${lastErr instanceof Error ? ` Last error: ${lastErr.message}` : ''}`,
      );
    }
    convertedImages++;
    out.push({
      type: 'text',
      text: `[Image ${convertedImages} analyzed via ${adapterName ?? 'vision adapter'}]\n${description.trim()}`,
    });
  }

  return { blocks: out, route: 'adapter', convertedImages, adapterName };
}

async function resolveAdapters(
  adapters: VisionAdapters | undefined,
): Promise<readonly VisionAdapter[]> {
  if (!adapters) return [];
  return typeof adapters === 'function' ? await adapters() : adapters;
}

export interface ToolVisionAdapterOptions {
  prompt?: string | undefined;
}

export function createToolVisionAdapters(
  registry: ToolRegistry,
  opts: ToolVisionAdapterOptions = {},
): VisionAdapter[] {
  return registry
    .list()
    .filter(isLikelyVisionTool)
    .map((tool) => ({
      name: tool.name,
      async describe(input: VisionAdapterInput): Promise<string> {
        const currentTool = registry.get(tool.name);
        if (!currentTool) {
          throw new Error(`Tool "${tool.name}" is no longer registered`);
        }
        const built = await buildToolPayload(currentTool, input.image, input.prompt ?? opts.prompt);
        if (!built) {
          throw new Error(
            `Tool "${currentTool.name}" does not expose a supported image input schema`,
          );
        }
        try {
          const result = await currentTool.execute(built.payload, input.ctx, {
            signal: input.signal,
          });
          return stringifyToolResult(result);
        } finally {
          await built.cleanup?.();
        }
      },
    }));
}

export const VISION_IMAGE_KEYS = [
  'image',
  'base64',
  'data',
  'url',
  'image_url',
  'imageUrl',
  'path',
  'image_path',
  'imagePath',
  'file_path',
  'filePath',
  'filename',
  'file',
  'mediaType',
  'mimeType',
] as const;

export const VISION_PATH_KEYS = [
  'path',
  'image_path',
  'imagePath',
  'image_url',
  'imageUrl',
  'file_path',
  'filePath',
  'filename',
  'file',
] as const;

export const VISION_MEDIA_TYPE_KEYS = ['mediaType', 'mimeType', 'media_type'] as const;
export const VISION_PROMPT_KEYS = ['prompt', 'query', 'instruction'] as const;

function isLikelyVisionTool(tool: Tool): boolean {
  if (tool.permission !== 'auto' || tool.mutating) return false;
  const haystack = `${tool.name} ${tool.description ?? ''} ${tool.usageHint ?? ''}`.toLowerCase();
  if (/(generate|create|draw|paint|edit|upscale|remove|write|delete)/.test(haystack)) return false;
  if (!/(vision|image|screenshot|ocr|describe|analy[sz]e)/.test(haystack)) return false;
  const props = schemaProperties(tool);
  return VISION_IMAGE_KEYS.some((key) => key in props);
}

async function buildToolPayload(
  tool: Tool,
  image: ImageBlock,
  prompt = 'Describe this image for a coding agent. Include visible text, UI state, errors, layout, and any details needed to answer the user.',
): Promise<{ payload: Record<string, unknown>; cleanup?: () => Promise<void> } | null> {
  const props = schemaProperties(tool);
  const payload: Record<string, unknown> = {};
  const mediaType = image.source.media_type ?? 'image/png';
  const data = image.source.data;
  const url = image.source.url;
  let cleanup: (() => Promise<void>) | undefined;

  // SSRF guard: when the image is referenced by URL, validate the host
  // BEFORE forwarding it to the underlying vision tool. The tool may
  // itself fetch the URL (the typical case for an MCP image-understanding
  // adapter), so a URL pointing at localhost / 127.0.0.1 / 169.254.169.254
  // / RFC1918 ranges would otherwise become an SSRF vector. Without this
  // gate, vision is a back-door around the fetch.ts SSRF guard (which
  // only applies when the explicit `fetch` tool is invoked).
  if (image.source.type === 'url' && url) {
    try {
      await assertNotPrivateHost(new URL(url).hostname);
    } catch (err) {
      const reason =
        err instanceof Error && err.message.startsWith('fetch:')
          ? err.message.slice('fetch:'.length).trim()
          : 'unresolvable host';
      throw new VisionUrlBlockedError({ url, reason });
    }
  }

  const pathKey = firstPresent(props, [...VISION_PATH_KEYS]);
  if (pathKey && image.source.type === 'base64' && data) {
    const p = await writeTempImage(data, mediaType);
    payload[pathKey] = p;
    cleanup = async () => {
      await fs.unlink(p).catch(() => undefined);
      await fs.rmdir(path.dirname(p)).catch(() => undefined);
    };
  } else if ('image' in props) {
    payload.image =
      image.source.type === 'base64'
        ? { type: 'base64', mediaType, media_type: mediaType, data }
        : { type: 'url', url };
  } else if (image.source.type === 'base64' && 'base64' in props) {
    payload.base64 = data;
  } else if (image.source.type === 'base64' && 'data' in props) {
    payload.data = data;
  } else if (image.source.type === 'url' && 'url' in props) {
    payload.url = url;
  } else if (image.source.type === 'url' && 'image_url' in props) {
    payload.image_url = url;
  } else if (image.source.type === 'url' && 'imageUrl' in props) {
    payload.imageUrl = url;
  } else {
    return null;
  }

  for (const key of VISION_MEDIA_TYPE_KEYS) {
    if (key in props) payload[key] = mediaType;
  }
  for (const key of VISION_PROMPT_KEYS) {
    if (key in props) payload[key] = prompt;
  }
  const built: { payload: Record<string, unknown>; cleanup?: () => Promise<void> } = { payload };
  if (cleanup !== undefined) built.cleanup = cleanup;
  return built;
}

function firstPresent(props: Record<string, unknown>, keys: string[]): string | undefined {
  return keys.find((key) => key in props);
}

async function writeTempImage(data: string, mediaType: string): Promise<string> {
  const ext = mediaType.includes('jpeg') || mediaType.includes('jpg') ? 'jpg' : 'png';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-vision-'));
  const file = path.join(dir, `image.${ext}`);
  await fs.writeFile(file, data, 'base64');
  return file;
}

function schemaProperties(tool: Tool): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') return {};
  const props = (schema as { properties?: unknown | undefined }).properties;
  return props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown | undefined }).text ?? '');
        }
        return typeof item === 'string' ? item : JSON.stringify(item);
      })
      .join('\n');
  }
  if (value && typeof value === 'object' && 'text' in value) {
    return String((value as { text?: unknown | undefined }).text ?? '');
  }
  return JSON.stringify(value);
}

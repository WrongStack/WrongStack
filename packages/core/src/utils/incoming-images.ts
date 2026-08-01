import type { ContentBlock, ImageBlock } from '../types/blocks.js';

/**
 * Wire shape for one image attached to a WebUI `user_message`. `data` may be
 * a bare base64 string or a full `data:` URL (the client normally strips the
 * prefix, but legacy senders shipped the whole URL).
 */
export interface IncomingImagePayload {
  data: string;
  mediaType?: string | undefined;
  /** Original filename, when the image came from a file picker or drop. */
  name?: string | undefined;
}

export const MAX_INCOMING_IMAGES = 8;

/**
 * Decoded-byte cap per image. The WebUI client downscales before sending, so
 * anything larger than this is either a bypassed client or an abuse attempt.
 * Kept under the servers' WS maxPayload once base64 overhead (~4/3) and the
 * surrounding JSON envelope are added.
 */
export const MAX_INCOMING_IMAGE_BYTES = 8 * 1024 * 1024;

/** Media types every supported vision wire accepts (Anthropic passthrough,
 *  OpenAI data-URLs, Gemini inlineData).
 *
 * Exported because this is the ONE allowlist for image ingest. Any surface
 * that accepts a client-supplied image block must check against this set —
 * see {@link isAllowedImageMediaType}. WS-032: the WebUI context editor was a
 * second ingest path that validated only the *types* of `source.media_type` /
 * `source.data`, never their values, so it bypassed every control below. */
export const ALLOWED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** Case-insensitive membership test against {@link ALLOWED_IMAGE_MEDIA_TYPES}. */
export function isAllowedImageMediaType(mediaType: string): boolean {
  return ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase());
}

/**
 * Cheap linear alphabet check that rejects raw binary or JSON smuggled into a
 * base64 image field before it reaches a provider wire.
 */
export function isValidImageBase64(base64: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(base64);
}

/** Decoded byte count for a base64 payload, for comparison against
 *  {@link MAX_INCOMING_IMAGE_BYTES}. */
export function base64DecodedBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/** Validation failure on user-supplied image payloads. The message is safe to
 *  echo back to the client verbatim. */
export class IncomingImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncomingImageError';
  }
}

const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?(?:;[a-z0-9-]+=[^;,]*)*(;base64)?,/i;

function splitDataUrl(data: string): { base64: string; mediaType?: string | undefined } {
  const match = DATA_URL_RE.exec(data);
  if (!match) return { base64: data.trim() };
  return {
    base64: data.slice(match[0].length).trim(),
    mediaType: match[1]?.toLowerCase(),
  };
}

/**
 * Validate and normalize the `images` field of a `user_message` payload into
 * canonical {@link ImageBlock}s. Accepts the legacy single `imageBase64`
 * field (a data-URL) as a trailing entry so old clients keep working.
 *
 * Throws {@link IncomingImageError} on count/size/media-type violations.
 */
export function parseIncomingImages(
  images?: readonly IncomingImagePayload[] | undefined,
  legacyImageBase64?: string | undefined,
): ImageBlock[] {
  const raw: IncomingImagePayload[] = [...(images ?? [])];
  if (legacyImageBase64) raw.push({ data: legacyImageBase64 });
  if (raw.length === 0) return [];
  if (raw.length > MAX_INCOMING_IMAGES) {
    throw new IncomingImageError(
      `Too many images: ${raw.length} (max ${MAX_INCOMING_IMAGES} per message).`,
    );
  }

  return raw.map((img, i) => {
    const { base64, mediaType: fromUrl } = splitDataUrl(img.data ?? '');
    const mediaType = (img.mediaType ?? fromUrl ?? 'image/png').toLowerCase();
    if (!isAllowedImageMediaType(mediaType)) {
      throw new IncomingImageError(
        `Image ${i + 1}: unsupported media type "${mediaType}" (allowed: ${[...ALLOWED_IMAGE_MEDIA_TYPES].join(', ')}).`,
      );
    }
    if (!base64) {
      throw new IncomingImageError(`Image ${i + 1}: empty image data.`);
    }
    if (!isValidImageBase64(base64)) {
      throw new IncomingImageError(`Image ${i + 1}: data is not valid base64.`);
    }
    const bytes = base64DecodedBytes(base64);
    if (bytes > MAX_INCOMING_IMAGE_BYTES) {
      throw new IncomingImageError(
        `Image ${i + 1}: ${(bytes / (1024 * 1024)).toFixed(1)} MB exceeds the ${MAX_INCOMING_IMAGE_BYTES / (1024 * 1024)} MB limit.`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 },
    } satisfies ImageBlock;
  });
}

/**
 * Assemble the agent input for a user message that carries images: image
 * blocks first (the order vision providers prefer), then the text block.
 */
export function buildUserContentBlocks(
  text: string,
  images: readonly ImageBlock[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [...images];
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

import type { ContentBlock, ImageBlock } from '@wrongstack/contracts/types/blocks';

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
  // Trailing `=` characters are padding, not data: 4 chars always carry 3
  // bytes, minus one per `=`. Ignoring them over-counted by up to 2 bytes, so a
  // payload of exactly the cap (or cap - 1) was rejected as oversized.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Validation failure on user-supplied image payloads. The message is safe to
 *  echo back to the client verbatim. */
export class IncomingImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncomingImageError';
  }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The allowed image type the payload's leading bytes actually are, or
 * `undefined` when they match none of them.
 *
 * The declared type is only a label: both composers send the browser's
 * `File.type` for images they pass through unchanged, and for a file from disk
 * that comes from the EXTENSION — a JPEG saved as `.png` arrives as
 * `image/png`. Providers that check (Anthropic) reject the mismatched block,
 * and since it stays in history every later turn fails the same way. Only the
 * first 16 base64 chars (12 bytes) are decoded, in plain JS so this module
 * stays browser-safe.
 */
function sniffAllowedImageMediaType(base64: string): string | undefined {
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of base64.slice(0, 16)) {
    const v = BASE64_ALPHABET.indexOf(ch);
    if (v < 0) break;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  const ascii = (start: number, text: string) =>
    [...text].every((ch, i) => bytes[start + i] === ch.charCodeAt(0));
  if (bytes[0] === 0x89 && ascii(1, 'PNG')) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return undefined;
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
      // The bytes decide when they are a recognised allowed type; otherwise
      // the (already allowlisted) declared type stands, as before.
      source: {
        type: 'base64',
        media_type: sniffAllowedImageMediaType(base64) ?? mediaType,
        data: base64,
      },
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

/** The one document type a composer attaches. */
export const PDF_MEDIA_TYPE = 'application/pdf';

export const MAX_INCOMING_DOCUMENTS = 4;

/**
 * Decoded-byte cap per PDF. A PDF cannot be downscaled the way an image can,
 * so this is the file as the user picked it; it keeps one PDF plus the
 * message envelope inside the servers' 20 MB WS frame.
 */
export const MAX_INCOMING_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** A validated PDF from a `user_message`, still to be turned into a block. */
export interface IncomingPdf {
  /** Bare base64. */
  data: string;
  name: string;
  bytes: number;
}

/** `%PDF-` in base64: every PDF starts with it. */
const PDF_BASE64_MAGIC = 'JVBERi0';

/**
 * Validate the attachments of a `user_message`. PDFs ride the same `images`
 * field as images (one composer pipeline carries both through queue, steer
 * and resend), told apart by media type; images go through
 * {@link parseIncomingImages} unchanged and PDFs are checked here.
 *
 * Throws {@link IncomingImageError} on any violation.
 */
export function parseIncomingAttachments(
  images?: readonly IncomingImagePayload[] | undefined,
  legacyImageBase64?: string | undefined,
): { images: ImageBlock[]; pdfs: IncomingPdf[] } {
  const imagePayloads: IncomingImagePayload[] = [];
  const pdfs: IncomingPdf[] = [];
  for (const item of images ?? []) {
    const { base64, mediaType: fromUrl } = splitDataUrl(item.data ?? '');
    if ((item.mediaType ?? fromUrl ?? '').toLowerCase() !== PDF_MEDIA_TYPE) {
      imagePayloads.push(item);
      continue;
    }
    // The name lands inside the `<attached-pdf name="…">` wrapper a model
    // without PDF input reads, so it must not be able to close that tag.
    const name =
      item.name
        ?.replace(/["<>\r\n]/g, '')
        .trim()
        .slice(0, 200) || `document-${pdfs.length + 1}.pdf`;
    if (!base64 || !isValidImageBase64(base64)) {
      throw new IncomingImageError(`PDF "${name}": data is not valid base64.`);
    }
    if (!base64.startsWith(PDF_BASE64_MAGIC)) {
      throw new IncomingImageError(`PDF "${name}": the file is not a PDF.`);
    }
    const bytes = base64DecodedBytes(base64);
    if (bytes > MAX_INCOMING_DOCUMENT_BYTES) {
      throw new IncomingImageError(
        `PDF "${name}": ${(bytes / (1024 * 1024)).toFixed(1)} MB exceeds the ${MAX_INCOMING_DOCUMENT_BYTES / (1024 * 1024)} MB limit.`,
      );
    }
    pdfs.push({ data: base64, name, bytes });
  }
  if (pdfs.length > MAX_INCOMING_DOCUMENTS) {
    throw new IncomingImageError(
      `Too many PDFs: ${pdfs.length} (max ${MAX_INCOMING_DOCUMENTS} per message).`,
    );
  }
  return { images: parseIncomingImages(imagePayloads, legacyImageBase64), pdfs };
}

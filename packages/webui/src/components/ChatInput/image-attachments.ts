/**
 * Client-side image attachment processing for the chat composer.
 *
 * Every image (pasted, dropped, or picked) passes through `processImageFile`
 * before it becomes a pending attachment:
 *
 *   - oversized or exotic formats are rasterized onto a canvas and re-encoded
 *     (WebP where the browser supports it, PNG/JPEG fallback), so what goes
 *     over the wire is always a provider-accepted media type at a sane size;
 *   - dimensions are capped at `MAX_DIMENSION` on the long edge — vision
 *     providers downscale past that anyway, so bigger is pure wire waste;
 *   - small images in an accepted format pass through untouched (GIFs keep
 *     their animation this way).
 *
 * The server re-validates independently (`parseIncomingImages` in core) —
 * this module is about UX and payload size, not trust.
 */

export interface ImageAttachment {
  id: string;
  /** Full data URL — used for the thumbnail preview and the wire payload. */
  dataUrl: string;
  mediaType: string;
  /** Approximate decoded size in bytes. */
  bytes: number;
  /** Original filename when the image came from a picker or drop. */
  name?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

/** Max images per message — mirrors core's MAX_INCOMING_IMAGES. */
export const MAX_ATTACHED_IMAGES = 8;

/** Long-edge cap. 2048px keeps text in screenshots legible while staying
 *  well under every provider's hard pixel limits. */
const MAX_DIMENSION = 2048;

/** Above this source size we always re-encode, even if dimensions fit. */
const RECOMPRESS_THRESHOLD_BYTES = 2 * 1024 * 1024;

/** Hard per-image cap after processing. Mirrors nothing server-side exactly
 *  (the server allows 8 MB) — the tighter client cap keeps multi-image
 *  messages inside the WS payload budget. */
export const MAX_PROCESSED_IMAGE_BYTES = 4 * 1024 * 1024;

/** Media types accepted by every supported vision wire. Anything else gets
 *  rasterized to one of these. */
const PASSTHROUGH_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class ImageAttachmentError extends Error {
  constructor(
    message: string,
    /** i18n key the caller can surface; message is the English fallback. */
    readonly reason: 'decode_failed' | 'too_large',
  ) {
    super(message);
    this.name = 'ImageAttachmentError';
  }
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function approximateBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64len = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
  return Math.floor((b64len * 3) / 4);
}

function mediaTypeOf(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl);
  return match?.[1] ?? 'image/png';
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Fallback path for formats createImageBitmap rejects (e.g. SVG in some
    // browsers) — decode through an <img> element instead.
    const url = URL.createObjectURL(file);
    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image decode failed'));
        img.src = url;
      });
    } finally {
      // Safe to revoke after load/error settled — the bitmap is decoded.
      URL.revokeObjectURL(url);
    }
  }
}

function encodeCanvas(
  source: ImageBitmap | HTMLImageElement,
  targetW: number,
  targetH: number,
  preferAlpha: boolean,
  quality: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageAttachmentError('canvas 2d context unavailable', 'decode_failed');
  ctx.drawImage(source, 0, 0, targetW, targetH);

  // WebP keeps alpha AND compresses well; browsers without WebP encoding
  // silently return PNG from toDataURL, which we detect and accept.
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  return preferAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
}

let attachmentSeq = 0;
function nextAttachmentId(): string {
  attachmentSeq += 1;
  return `img_${Date.now()}_${attachmentSeq}`;
}

/**
 * Normalize one image file into a pending attachment: decode, downscale to
 * `MAX_DIMENSION`, re-encode when the source is oversized or in a format
 * providers don't accept. Throws {@link ImageAttachmentError} when the file
 * can't be decoded or can't be squeezed under the size cap.
 */
export async function processImageFile(file: File): Promise<ImageAttachment> {
  const passthroughType = PASSTHROUGH_TYPES.has(file.type);

  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = await decode(file);
  } catch {
    throw new ImageAttachmentError(`Could not decode image "${file.name}"`, 'decode_failed');
  }
  const width = bitmap.width;
  const height = bitmap.height;
  const longEdge = Math.max(width, height);

  const needsWork =
    !passthroughType || longEdge > MAX_DIMENSION || file.size > RECOMPRESS_THRESHOLD_BYTES;

  if (!needsWork) {
    const dataUrl = await readFileAsDataURL(file);
    return {
      id: nextAttachmentId(),
      dataUrl,
      mediaType: file.type,
      bytes: approximateBytes(dataUrl),
      name: file.name || undefined,
      width,
      height,
    };
  }

  // JPEG sources have no alpha; everything else might, so prefer an
  // alpha-preserving fallback encoding for them.
  const preferAlpha = file.type !== 'image/jpeg';
  let scale = Math.min(1, MAX_DIMENSION / longEdge);
  let quality = 0.85;
  let dataUrl = encodeCanvas(
    bitmap,
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
    preferAlpha,
    quality,
  );

  if (approximateBytes(dataUrl) > MAX_PROCESSED_IMAGE_BYTES) {
    // One tighter pass before giving up — smaller long edge, lower quality.
    scale = Math.min(scale, 1280 / longEdge);
    quality = 0.7;
    dataUrl = encodeCanvas(
      bitmap,
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
      preferAlpha,
      quality,
    );
  }
  if ('close' in bitmap) bitmap.close();

  const bytes = approximateBytes(dataUrl);
  if (bytes > MAX_PROCESSED_IMAGE_BYTES) {
    throw new ImageAttachmentError(
      `Image "${file.name}" is too large after compression`,
      'too_large',
    );
  }

  return {
    id: nextAttachmentId(),
    dataUrl,
    mediaType: mediaTypeOf(dataUrl),
    bytes,
    name: file.name || undefined,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Wire shape sent inside the `user_message` payload (`images` field). */
interface WireImage {
  data: string;
  mediaType: string;
  name?: string | undefined;
}

/** Strip the data-URL prefix — the wire carries bare base64 + mediaType. */
export function toWireImages(attachments: readonly ImageAttachment[]): WireImage[] {
  return attachments.map((a) => {
    const comma = a.dataUrl.indexOf(',');
    return {
      data: comma >= 0 ? a.dataUrl.slice(comma + 1) : a.dataUrl,
      mediaType: a.mediaType,
      ...(a.name ? { name: a.name } : {}),
    };
  });
}

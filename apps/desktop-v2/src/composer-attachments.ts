import type { WSUserMessageImage } from '@wrongstack/webui-protocol';
import { entries, record } from './engine-values.js';

export interface ComposerAttachment extends WSUserMessageImage {
  id: string;
  name: string;
  bytes: number;
}
// Match canonical ingest counts; the engine independently validates every payload.
export const attachmentLimits = {
  images: 8,
  pdfs: 4,
  pdfBytes: 8 * 1024 * 1024,
  imageBytes: 4 * 1024 * 1024,
  wireBytes: 18 * 1024 * 1024,
  queueBytes: 7 * 1024 * 1024,
};
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const isPdf = (item: { mediaType: string }) => item.mediaType === 'application/pdf';
/** The attachment's decoded bytes. */
export function decodeAttachment(item: Pick<WSUserMessageImage, 'data'>): Uint8Array<ArrayBuffer> {
  const text = atob(item.data);
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}
export const attachmentDataUrl = (item: WSUserMessageImage) =>
  `data:${item.mediaType};base64,${item.data}`;
export function wireAttachments(items: readonly ComposerAttachment[]): WSUserMessageImage[] {
  return items.map(({ data, mediaType, name }) => ({ data, mediaType, name }));
}
export function attachmentBytes(data: string): number {
  return Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}
export function validateAttachments(items: readonly WSUserMessageImage[], queued = false): void {
  let images = 0;
  let pdfs = 0;
  for (const item of items) {
    const pdf = isPdf(item);
    if (!pdf && !imageTypes.has(item.mediaType)) throw Error('Attach a supported image or PDF.');
    if (!item.data || item.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data))
      throw Error(`“${item.name ?? 'Attachment'}” contains invalid file data.`);
    if (pdf && !item.data.startsWith('JVBERi0')) throw Error('The selected file is not a PDF.');
    const max = pdf ? attachmentLimits.pdfBytes : attachmentLimits.imageBytes;
    if (attachmentBytes(item.data) > max)
      throw Error(`“${item.name ?? 'Attachment'}” exceeds the ${max / 1024 / 1024} MB file limit.`);
    if (pdf) pdfs++;
    else images++;
  }
  if (images > attachmentLimits.images || pdfs > attachmentLimits.pdfs)
    throw Error('A message can contain up to 8 images and 4 PDFs.');
  if (
    new TextEncoder().encode(JSON.stringify(items)).length >
    (queued ? attachmentLimits.queueBytes : attachmentLimits.wireBytes)
  )
    throw Error(
      queued
        ? 'These attachments are too large to queue. Remove a file or send directly after this turn.'
        : 'These attachments exceed the message size limit. Remove a file and retry.',
    );
}
export function validateAttachmentPayload(payload: unknown, queued: boolean): void {
  const max = queued ? attachmentLimits.queueBytes : attachmentLimits.wireBytes;
  if (new TextEncoder().encode(JSON.stringify(payload)).length > max)
    throw Error('This message and its attachments are too large. Your draft is kept.');
}
function readData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(Error('The selected file could not be read.'));
    reader.readAsDataURL(file);
  });
}
/** Desktop-owned processing: no WebUI frontend import or remote upload. */
export async function processAttachmentFile(file: File): Promise<ComposerAttachment> {
  const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!file.size) throw Error(`“${file.name}” is empty.`);
  if (file.size > (pdf ? attachmentLimits.pdfBytes : 32 * 1024 * 1024))
    throw Error(pdf ? 'PDFs must be 8 MB or smaller.' : 'Source images must be 32 MB or smaller.');
  let data: string;
  let mediaType: string;
  if (pdf) {
    mediaType = 'application/pdf';
    data = await readData(file);
  } else {
    if (!file.type.startsWith('image/')) throw Error('Choose an image or PDF file.');
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw Error(`“${file.name}” could not be decoded as an image.`);
    }
    try {
      // The byte signature, rather than an extension-derived MIME label, wins.
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const ascii = String.fromCharCode(...head);
      const detected =
        head[0] === 137 && ascii.slice(1, 4) === 'PNG'
          ? 'image/png'
          : head[0] === 255 && head[1] === 216 && head[2] === 255
            ? 'image/jpeg'
            : ascii.startsWith('GIF8')
              ? 'image/gif'
              : ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
                ? 'image/webp'
                : '';
      if (
        detected &&
        file.size <= 2 * 1024 * 1024 &&
        Math.max(bitmap.width, bitmap.height) <= 2048
      ) {
        mediaType = detected;
        data = await readData(file);
      } else {
        const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw Error('Image processing is unavailable.');
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/webp', 0.85);
        mediaType = url.slice(5, url.indexOf(';'));
        data = url.slice(url.indexOf(',') + 1);
      }
    } finally {
      bitmap.close();
    }
  }
  const item = {
    id: crypto.randomUUID(),
    name: file.name || (pdf ? 'document.pdf' : 'image'),
    data,
    mediaType,
    bytes: attachmentBytes(data),
  };
  validateAttachments([item]);
  return item;
}
/** Read only allowed inline media. Never create previews for remote or arbitrary data URLs. */
export function transcriptAttachments(value: unknown): ComposerAttachment[] {
  return entries(value).flatMap((item, index) => {
    const source = record(item['source']);
    const mediaType = String(item['mediaType'] ?? source['media_type'] ?? '');
    const data = item['data'] ?? source['data'];
    if (
      typeof data !== 'string' ||
      !data ||
      (!imageTypes.has(mediaType) && mediaType !== 'application/pdf')
    )
      return [];
    const attachment = {
      id: `media-${index}`,
      data,
      mediaType,
      name: String(
        item['name'] ?? (mediaType === 'application/pdf' ? 'document.pdf' : `Image ${index + 1}`),
      ),
      bytes: attachmentBytes(data),
    };
    try {
      validateAttachments([attachment]);
      return [attachment];
    } catch {
      return [];
    }
  });
}

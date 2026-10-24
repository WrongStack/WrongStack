import { type DocumentBlock, documentAsText, type ImageBlock } from '@wrongstack/contracts/types';
import { isStandardBase64Payload } from '@wrongstack/core/utils';

export const IMAGE_OMITTED_TEXT_ONLY = '[image omitted: model accepts text only]';
export const IMAGE_OMITTED_INVALID_BASE64 = '[image omitted: invalid base64 data; reattach image]';
export const IMAGE_OMITTED_REMOTE_URL =
  '[image omitted: provider requires uploaded image data; reattach image]';
export const DOCUMENT_OMITTED_INVALID_BASE64 =
  '[document omitted: invalid base64 data; reattach document]';

export interface NativeImagePolicy {
  allowImages?: boolean | undefined;
  allowImageUrls?: boolean | undefined;
}

/** Text fallback when an image cannot safely ride the selected native wire. */
export function imageInputFallback(
  block: ImageBlock,
  policy: NativeImagePolicy = {},
): string | undefined {
  if (policy.allowImages === false) return IMAGE_OMITTED_TEXT_ONLY;
  if (block.source.type === 'base64') {
    return isStandardBase64Payload(block.source.data ?? '')
      ? undefined
      : IMAGE_OMITTED_INVALID_BASE64;
  }
  if (policy.allowImageUrls === false) return IMAGE_OMITTED_REMOTE_URL;
  const url = block.source.url?.trim();
  if (!url) return IMAGE_OMITTED_REMOTE_URL;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? undefined : IMAGE_OMITTED_REMOTE_URL;
  } catch {
    return IMAGE_OMITTED_REMOTE_URL;
  }
}

/** Extracted-text fallback when a PDF cannot safely ride the selected wire. */
export function documentInputFallback(
  block: DocumentBlock,
  allowDocuments = true,
): string | undefined {
  if (allowDocuments && isStandardBase64Payload(block.source.data)) return undefined;
  return documentAsText(block).text || DOCUMENT_OMITTED_INVALID_BASE64;
}

/**
 * True when `value` is an opaque media payload that must not be treated as
 * prose by credential scrubbers. Random image bytes can contain a token-shaped
 * base64 run by chance; replacing that run corrupts the attachment.
 *
 * The exemption is deliberately narrow: the parent must carry a recognized
 * media shape and the payload must use the standard base64 alphabet (or be a
 * base64 data URL). Arbitrary `data` fields continue through normal scrubbing.
 */
export function isOpaqueMediaStringField(
  parent: Record<string, unknown>,
  key: string,
  value: unknown,
): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;

  if (key === 'data') {
    const sourceMediaType =
      typeof parent['media_type'] === 'string'
        ? parent['media_type']
        : typeof parent['mimeType'] === 'string'
          ? parent['mimeType']
          : undefined;
    const mediaType = sourceMediaType?.toLowerCase();
    const mediaContainer =
      parent['type'] === 'base64' || parent['type'] === 'image' || parent['type'] === 'audio';
    if (mediaContainer && isOpaqueMediaType(mediaType) && isStandardBase64Payload(value)) {
      return true;
    }
  }

  if (key === 'image_url' && parent['type'] === 'input_image') {
    return isBase64DataUrl(value, 'image/');
  }
  if (key === 'audio_url' && parent['type'] === 'input_audio') {
    return isBase64DataUrl(value, 'audio/');
  }
  if (key === 'file_data' && parent['type'] === 'input_file') {
    return isBase64DataUrl(value, 'application/pdf');
  }
  return false;
}

function isOpaqueMediaType(mediaType: string | undefined): boolean {
  return (
    mediaType?.startsWith('image/') === true ||
    mediaType?.startsWith('audio/') === true ||
    mediaType === 'application/pdf'
  );
}

/** Standard base64 payload, allowing omitted padding but rejecting impossible lengths. */
export function isStandardBase64Payload(value: string): boolean {
  return value.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isBase64DataUrl(value: string, mediaPrefix: string): boolean {
  const comma = value.indexOf(',');
  if (comma < 0) return false;
  const header = value.slice(0, comma).toLowerCase();
  return (
    header.startsWith(`data:${mediaPrefix}`) &&
    header.endsWith(';base64') &&
    isStandardBase64Payload(value.slice(comma + 1))
  );
}

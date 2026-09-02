import { describe, expect, it } from 'vitest';
import {
  buildUserContentBlocks,
  IncomingImageError,
  MAX_INCOMING_IMAGE_BYTES,
  MAX_INCOMING_IMAGES,
  parseIncomingImages,
} from '../../src/utils/incoming-images.js';

// 1×1 transparent PNG, valid base64.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('parseIncomingImages', () => {
  it('returns [] for no images', () => {
    expect(parseIncomingImages(undefined, undefined)).toEqual([]);
    expect(parseIncomingImages([], undefined)).toEqual([]);
  });

  it('converts bare base64 + mediaType to an ImageBlock', () => {
    const blocks = parseIncomingImages([{ data: PNG_B64, mediaType: 'image/png' }]);
    expect(blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
    ]);
  });

  it('strips a data-URL prefix and derives the media type from it', () => {
    const blocks = parseIncomingImages([{ data: `data:image/jpeg;base64,${PNG_B64}` }]);
    expect(blocks[0]?.source.media_type).toBe('image/jpeg');
    expect(blocks[0]?.source.data).toBe(PNG_B64);
  });

  it('explicit mediaType wins over the data-URL prefix', () => {
    const blocks = parseIncomingImages([
      { data: `data:image/png;base64,${PNG_B64}`, mediaType: 'image/webp' },
    ]);
    expect(blocks[0]?.source.media_type).toBe('image/webp');
  });

  it('accepts the legacy imageBase64 field as a trailing image', () => {
    const blocks = parseIncomingImages(
      [{ data: PNG_B64, mediaType: 'image/png' }],
      `data:image/png;base64,${PNG_B64}`,
    );
    expect(blocks).toHaveLength(2);
  });

  it('defaults media type to image/png when nothing declares it', () => {
    const blocks = parseIncomingImages([{ data: PNG_B64 }]);
    expect(blocks[0]?.source.media_type).toBe('image/png');
  });

  it('rejects more than MAX_INCOMING_IMAGES', () => {
    const many = Array.from({ length: MAX_INCOMING_IMAGES + 1 }, () => ({
      data: PNG_B64,
      mediaType: 'image/png',
    }));
    expect(() => parseIncomingImages(many)).toThrow(IncomingImageError);
  });

  it('rejects unsupported media types', () => {
    expect(() => parseIncomingImages([{ data: PNG_B64, mediaType: 'image/svg+xml' }])).toThrow(
      /unsupported media type/,
    );
  });

  it('rejects empty and non-base64 data', () => {
    expect(() => parseIncomingImages([{ data: '' }])).toThrow(/empty image data/);
    expect(() => parseIncomingImages([{ data: 'not valid base64!!' }])).toThrow(/not valid base64/);
  });

  it('rejects oversized images', () => {
    // Base64 length for > MAX bytes: 4/3 ratio, padded to a multiple of 4.
    const b64len = Math.ceil(((MAX_INCOMING_IMAGE_BYTES + 4) * 4) / 3 / 4) * 4;
    const huge = 'A'.repeat(b64len);
    expect(() => parseIncomingImages([{ data: huge, mediaType: 'image/png' }])).toThrow(
      /exceeds the/,
    );
  });
});

describe('buildUserContentBlocks', () => {
  const img = parseIncomingImages([{ data: PNG_B64, mediaType: 'image/png' }]);

  it('puts images before the text block', () => {
    const blocks = buildUserContentBlocks('hello', img);
    expect(blocks.map((b) => b.type)).toEqual(['image', 'text']);
  });

  it('omits the text block for an image-only message', () => {
    expect(buildUserContentBlocks('', img).map((b) => b.type)).toEqual(['image']);
  });
});

import { describe, expect, it } from 'vitest';
import { isOpaqueMediaStringField } from '../src/opaque-media.js';
import { DefaultSecretScrubber } from '../src/secret-scrubber.js';

const token = ['AKIA', 'A'.repeat(16)].join('');
const marker = '[REDACTED:aws_access_key]';
const scrubber = new DefaultSecretScrubber();

describe('PDF data-URL media-type boundaries', () => {
  it.each([
    'application/pdf-extra',
    'application/pdf2',
    'application/pdffoo',
    'application/pdf+json',
  ])('does not exempt a distinct MIME type beginning with %s', (mime) => {
    const prefix = 'data:' + mime + ';base64,';
    const input = { type: 'input_file', file_data: prefix + token };
    expect(isOpaqueMediaStringField(input, 'file_data', input.file_data)).toBe(false);
    expect(isOpaqueMediaStringField({ type: 'base64', mimeType: mime }, 'data', token)).toBe(false);
    for (const method of ['scrubObject', 'scrubObjectShared'] as const) {
      expect(scrubber[method](input)).toEqual({ ...input, file_data: prefix + marker });
    }
    expect(input.file_data).toBe(prefix + token);
  });

  it.each([
    'data:application/pdf;base64,',
    'data:APPLICATION/PDF;BASE64,',
    'data:application/pdf;name=fixture.pdf;base64,',
  ])('preserves genuine PDF payloads with header %s', (prefix) => {
    const input = { type: 'input_file', file_data: prefix + token, note: token };
    expect(isOpaqueMediaStringField(input, 'file_data', input.file_data)).toBe(true);
    for (const method of ['scrubObject', 'scrubObjectShared'] as const) {
      expect(scrubber[method](input)).toEqual({ ...input, note: marker });
    }
  });

  it.each([
    ['input_image', 'image_url', 'image/png'],
    ['input_image', 'image_url', 'image/jpeg'],
    ['input_audio', 'audio_url', 'audio/wav'],
    ['input_audio', 'audio_url', 'audio/mpeg'],
  ] as const)('retains %s family-prefix support for %s / %s', (type, key, mime) => {
    const input = { type, [key]: 'data:' + mime + ';base64,' + token };
    expect(isOpaqueMediaStringField(input, key, input[key])).toBe(true);
    expect(scrubber.scrubObject(input)).toEqual(input);
    expect(scrubber.scrubObjectShared(input)).toEqual(input);
  });
});

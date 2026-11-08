import { describe, expect, it } from 'vitest';
import { isStandardBase64Payload } from '../src/opaque-media.js';
import { DefaultSecretScrubber } from '../src/secret-scrubber.js';

describe('base64 padding in opaque media', () => {
  it.each(['AA', 'AAA', 'AAAA', 'AA==', 'AAA=', 'AAAAAA==', 'AAAAAAA='])(
    'accepts correctly padded or unpadded payload %s',
    (value) => {
      expect(isStandardBase64Payload(value)).toBe(true);
    },
  );

  it.each(['', 'A', 'AAAAA', 'A=', 'A==', 'AA=', 'AAAAAA=', 'AA===', 'AA=A'])(
    'rejects impossible padding or length in %s',
    (value) => {
      expect(isStandardBase64Payload(value)).toBe(false);
    },
  );

  it.each(['scrubObject', 'scrubObjectShared'] as const)(
    '%s scrubs malformed media but preserves valid media bytes',
    (method) => {
      const token = ['AKIA', 'A'.repeat(16)].join('');
      const scrubber = new DefaultSecretScrubber();
      const marker = '[REDACTED:aws_access_key]';
      for (const mediaType of ['image/png', 'audio/wav', 'application/pdf']) {
        const valid = { type: 'base64', media_type: mediaType, data: token, note: token };
        expect(scrubber[method](valid)).toEqual({ ...valid, note: marker });
        const invalid = { ...valid, data: token + '==' };
        expect(scrubber[method](invalid)).toEqual({
          ...invalid,
          data: marker + '==',
          note: marker,
        });
        expect(invalid.data).toBe(token + '==');
      }
      for (const [type, key, mime] of [
        ['input_image', 'image_url', 'image/png'],
        ['input_audio', 'audio_url', 'audio/wav'],
        ['input_file', 'file_data', 'application/pdf'],
      ] as const) {
        const prefix = 'data:' + mime + ';base64,';
        const valid = { type, [key]: prefix + token };
        expect(scrubber[method](valid)).toEqual(valid);
        const invalid = { type, [key]: prefix + token + '==' };
        expect(scrubber[method](invalid)).toEqual({ type, [key]: prefix + marker + '==' });
      }
    },
  );
});

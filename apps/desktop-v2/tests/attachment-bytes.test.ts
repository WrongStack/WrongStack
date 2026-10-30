import { describe, expect, it } from 'vitest';
import { decodeAttachment } from '../src/composer-attachments';

describe('attachment bytes', () => {
  it('decodes the stored base64 exactly', () => {
    const original = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a]);
    const data = btoa(String.fromCharCode(...original));
    expect([...decodeAttachment({ data })]).toEqual([...original]);
  });
});

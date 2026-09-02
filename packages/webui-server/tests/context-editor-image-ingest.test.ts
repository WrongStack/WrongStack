/**
 * WS-032 — the context editor was a second image-ingest path with no controls.
 *
 * `validateContextEditorMessages` re-validates a client-supplied message
 * history before it is persisted and replayed, and it is strict about every
 * other block type. The `image` case checked only the *types* of
 * `source.media_type` / `source.data` / `source.url`, never their values, so it
 * bypassed everything `parseIncomingImages` enforces on the normal path: the
 * media-type allowlist, the base64 alphabet check, and the 8 MB cap.
 *
 * Two consequences beyond "unvalidated input":
 *
 *  - `media_type` is interpolated into a `data:` URL by the OpenAI and
 *    Responses wires (`data:${media_type};base64,${data}`), so an arbitrary
 *    value is injection into that URL, not merely a wrong label.
 *  - `parseIncomingImages` always emits `type: 'base64'`, so the context editor
 *    was the ONLY way a url-sourced image could enter WebUI history — and the
 *    SSRF guard for image URLs lives in `routeImagesForModel`, which runs on
 *    the new-message path and never on replayed history. Both wires forward
 *    `source.url` to the provider verbatim.
 */
import { describe, expect, it } from 'vitest';
import { validateContextEditorMessages } from '../src/server/context-editor.js';

const PNG_B64 = 'iVBORw0KGgo=';

function validateImage(source: unknown): { codes: string[]; accepted: boolean } {
  const result = validateContextEditorMessages([
    { role: 'user', content: [{ type: 'image', source }] },
  ]);
  const first = result.messages[0];
  const blocks = Array.isArray(first?.content) ? first.content : [];
  return {
    codes: result.errors.map((e) => e.code),
    accepted: blocks.some((b) => b.type === 'image'),
  };
}

describe('context editor image media_type (WS-032)', () => {
  it('rejects a media type outside the ingest allowlist', () => {
    const out = validateImage({ type: 'base64', media_type: 'text/html', data: PNG_B64 });
    expect(out.accepted).toBe(false);
    expect(out.codes).toContain('UNSUPPORTED_IMAGE_MEDIA_TYPE');
  });

  it('rejects a media type crafted to break out of the data: URL', () => {
    // `data:${media_type};base64,${data}` — the wires build this string.
    const out = validateImage({
      type: 'base64',
      media_type: 'image/png;base64,AAAA",\\"x\\":\\"y',
      data: PNG_B64,
    });
    expect(out.accepted).toBe(false);
    expect(out.codes).toContain('UNSUPPORTED_IMAGE_MEDIA_TYPE');
  });

  it('accepts the allowlisted types, case-insensitively', () => {
    for (const mt of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG']) {
      const out = validateImage({ type: 'base64', media_type: mt, data: PNG_B64 });
      expect(out.accepted, mt).toBe(true);
      expect(out.codes, mt).toEqual([]);
    }
  });
});

describe('context editor base64 image data (WS-032)', () => {
  it('rejects data that is not base64', () => {
    const out = validateImage({ type: 'base64', media_type: 'image/png', data: '<<not b64>>' });
    expect(out.accepted).toBe(false);
    expect(out.codes).toContain('INVALID_IMAGE_DATA');
  });

  it('rejects a base64 source with no data at all', () => {
    // Previously accepted, producing `data:image/png;base64,` on the wire.
    expect(validateImage({ type: 'base64', media_type: 'image/png' }).accepted).toBe(false);
    expect(validateImage({ type: 'base64', media_type: 'image/png', data: '' }).accepted).toBe(
      false,
    );
  });

  it('enforces the same 8 MB decoded cap as the normal ingest path', () => {
    const out = validateImage({
      type: 'base64',
      media_type: 'image/png',
      data: 'A'.repeat(12 * 1024 * 1024),
    });
    expect(out.accepted).toBe(false);
    expect(out.codes).toContain('IMAGE_TOO_LARGE');
  });

  it('accepts a well-formed base64 image', () => {
    const out = validateImage({ type: 'base64', media_type: 'image/png', data: PNG_B64 });
    expect(out.accepted).toBe(true);
    expect(out.codes).toEqual([]);
  });
});

describe('context editor url image source (WS-032)', () => {
  const rejected = (url: string) => validateImage({ type: 'url', media_type: 'image/png', url });

  it('rejects the cloud metadata endpoint and loopback', () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://127.0.0.1/api/secrets',
      'https://localhost:3456/api/command',
      'https://[::1]/x.png',
      'https://10.0.0.5/internal.png',
      'https://192.168.1.1/router.png',
    ]) {
      const out = rejected(url);
      expect(out.accepted, url).toBe(false);
      expect(out.codes, url).toContain('UNSAFE_IMAGE_URL');
    }
  });

  it('rejects non-https schemes, including file: and data:', () => {
    for (const url of [
      'file:///etc/passwd',
      'file:///C:/Users/me/.wrongstack/config.json',
      'data:text/html,<script>x</script>',
      'http://example.com/a.png',
      'gopher://example.com/',
      'not-a-url',
    ]) {
      const out = rejected(url);
      expect(out.accepted, url).toBe(false);
      expect(out.codes, url).toContain('UNSAFE_IMAGE_URL');
    }
  });

  it('is not bypassed by a trailing FQDN dot', () => {
    // Exact equality on "localhost" is one character away from being bypassed.
    for (const url of ['https://localhost./x.png', 'https://sub.localhost./x.png']) {
      const out = rejected(url);
      expect(out.accepted, url).toBe(false);
      expect(out.codes, url).toContain('UNSAFE_IMAGE_URL');
    }
  });

  it('rejects embedded credentials', () => {
    const out = rejected('https://user:pass@example.com/a.png');
    expect(out.accepted).toBe(false);
    expect(out.codes).toContain('UNSAFE_IMAGE_URL');
  });

  it('rejects a url source with no url', () => {
    expect(validateImage({ type: 'url', media_type: 'image/png' }).accepted).toBe(false);
  });

  it('rejects public URL sources because provider-side fetches cannot be DNS-pinned here', () => {
    for (const url of ['https://example.com/photo.png', 'https://internal.example.com/a.png']) {
      const out = rejected(url);
      expect(out.accepted, url).toBe(false);
      expect(out.codes, url).toContain('UNSAFE_IMAGE_URL');
    }
  });
});

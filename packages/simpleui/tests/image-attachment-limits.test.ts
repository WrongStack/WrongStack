/**
 * WS-055 — SimpleUI attached images with no count, size or type screening,
 * and a wire key the server never reads.
 *
 * Two separate problems, and it matters not to overstate either.
 *
 * 1. No client-side limits. Every picked file was read straight into base64
 *    via `readAsDataURL`, so a 500 MB file became a ~666 MB string in the tab
 *    before anything checked it, and the user only learned it was refused
 *    after the payload crossed the WebSocket. The SERVER is and remains the
 *    enforcing layer — `parseIncomingImages` re-checks count, size and media
 *    type, so this was never a route to an unvalidated image reaching the
 *    agent. What it was: browser memory pressure and a late, opaque failure.
 *
 * 2. Wire-key drift. The composer sent `{ data, mime }`, but the server's
 *    `IncomingImagePayload` reads `mediaType`. The declared type was therefore
 *    dropped on arrival and `parseIncomingImages` fell back to parsing the
 *    `data:` URL — so the type the UI displayed and the type the server
 *    validated were never the same value.
 *
 * The limits are duplicated in SimpleUI rather than imported, because it is a
 * browser bundle that deliberately depends on nothing from `@wrongstack/core`.
 * This file runs in Node, so it CAN import the canonical values — which is the
 * whole point: it fails if the copy drifts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  MAX_INCOMING_IMAGE_BYTES,
  MAX_INCOMING_IMAGES,
} from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(import.meta.dirname, '../src/hooks/use-image-attachments.ts'),
  'utf8',
);

/** Pull a literal out of the hook source, so the assertion reads the copy. */
function literal(name: string): string {
  const match = new RegExp(`const ${name} =\\s*([^;]+);`).exec(source);
  expect(match, `${name} must exist in use-image-attachments.ts`).not.toBeNull();
  return match![1]!.trim();
}

describe('SimpleUI client limits match the canonical ones (WS-055)', () => {
  it('allows exactly the media types core allows', () => {
    const declared = literal('ALLOWED_IMAGE_MIME_TYPES');
    for (const type of ALLOWED_IMAGE_MEDIA_TYPES) {
      expect(declared, `${type} missing from the SimpleUI copy`).toContain(type);
    }
    // And nothing extra — a wider client list would let a file through to a
    // server rejection, which is the confusing failure this is meant to avoid.
    const listed = declared.match(/'([^']+)'/g)?.map((s) => s.replaceAll("'", '')) ?? [];
    expect([...listed].sort()).toEqual([...ALLOWED_IMAGE_MEDIA_TYPES].sort());
  });

  it('uses the same count cap', () => {
    expect(literal('MAX_IMAGES')).toBe(String(MAX_INCOMING_IMAGES));
  });

  it('uses the same byte cap', () => {
    // Written as `8 * 1024 * 1024`, so compare the computed value rather than
    // the text — otherwise a reformat to `8388608` would fail a matching cap.
    // Parsed with a strict digits-and-`*` reducer instead of eval: this reads
    // a source file, and a test has no business executing what it finds there
    // even when the file is ours.
    const expr = literal('MAX_IMAGE_BYTES');
    expect(expr, 'byte cap must be a plain product of integers').toMatch(/^\d+(\s*\*\s*\d+)*$/);
    const clientBytes = expr.split('*').reduce((acc, part) => acc * Number(part.trim()), 1);
    expect(clientBytes).toBe(MAX_INCOMING_IMAGE_BYTES);
  });

  it('screens before reading, not after', () => {
    // The memory-pressure half: the check must happen on the File, not on the
    // FileReader result. If `rejectionReason` ever moves below `readAsDataURL`
    // the limits still "work" but stop protecting the tab.
    // Match the CALL, not the mention of `readAsDataURL` in the doc comment
    // near the top of the file — that comment is what an `indexOf` on the bare
    // name finds, and it sits above everything.
    const checkIdx = source.indexOf('rejectionReason(file');
    const readIdx = source.indexOf('reader.readAsDataURL(file)');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(readIdx);
  });

  it('rejects an unknown type rather than defaulting it to image/png', () => {
    // `file.type` is empty for an unrecognised extension. Defaulting would
    // label a non-image as a PNG on the way to the provider wire.
    expect(source).toContain("if (!mime) return 'unknown image type'");
  });
});

describe('wire key reaches the server (WS-055)', () => {
  const composer = readFileSync(
    resolve(import.meta.dirname, '../src/hooks/use-composer-actions.ts'),
    'utf8',
  );

  it('sends mediaType, the field IncomingImagePayload actually reads', () => {
    expect(composer).toContain('mediaType: img.mime');
  });

  it('still sends mime, which the local queue-replay path reads', () => {
    // Dropping it would fix the drift by breaking the other consumer.
    expect(composer).toContain('mime: img.mime');
  });
});

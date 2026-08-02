import { useCallback, useRef, useState } from 'react';

export interface AttachedImage {
  id: string;
  data: string;
  mime: string;
  name: string;
}

/**
 * Client-side ingest limits (WS-055).
 *
 * These duplicate `ALLOWED_IMAGE_MEDIA_TYPES` / `MAX_INCOMING_IMAGES` /
 * `MAX_INCOMING_IMAGE_BYTES` in `@wrongstack/core/utils`. The duplication is
 * deliberate and not laziness: SimpleUI imports nothing from `@wrongstack/core`
 * on purpose — it is a browser bundle, and pulling the core barrel in drags
 * Node built-ins into it. `tests/image-attachment-limits.test.ts` runs in Node,
 * reads the canonical core source, and fails if these drift, so the copy cannot
 * silently diverge.
 *
 * The SERVER remains the enforcing layer: `parseIncomingImages` re-checks all
 * three and is what actually protects the agent. What these buy is different —
 * without them the browser reads unbounded files into base64 in memory (a
 * `readAsDataURL` of a 500 MB file is ~666 MB of string) and the user only
 * learns it was rejected after the whole payload crosses the WebSocket.
 */
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface RejectedImage {
  name: string;
  reason: string;
}

function rejectionReason(file: File, alreadyAttached: number, indexInBatch: number): string | null {
  if (alreadyAttached + indexInBatch >= MAX_IMAGES) {
    return `too many images (max ${MAX_IMAGES})`;
  }
  // `file.type` is the browser's sniffed type and can be empty for an unknown
  // extension. Empty is rejected rather than defaulted to image/png: guessing
  // is how a non-image reaches the provider wire labelled as one.
  const mime = file.type.toLowerCase();
  if (!mime) return 'unknown image type';
  if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) {
    return `unsupported type "${mime}"`;
  }
  // Checked BEFORE reading: the point is not to hold the bytes at all.
  if (file.size > MAX_IMAGE_BYTES) {
    return `${(file.size / (1024 * 1024)).toFixed(1)} MB exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit`;
  }
  return null;
}

export interface UseImageAttachmentsResult {
  attachedImages: AttachedImage[];
  /** Files refused by the client-side limits, with the reason (WS-055). */
  rejectedImages: RejectedImage[];
  attachImages: () => void;
  removeImage: (id: string) => void;
  setAttachedImages: React.Dispatch<React.SetStateAction<AttachedImage[]>>;
}

function generateId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Owns the image attachment lifecycle: triggering the file picker, reading
 * selected files as base64 data URLs, and removing individual images.
 *
 * Behavioural contract (must survive the PR-5 extraction from `app.tsx`):
 *  - `attachImages()` creates a hidden `<input type="file" accept="image/*"
 *    multiple>` element, programmatically clicks it, and reads each selected
 *    file via `FileReader.readAsDataURL`. The input is removed after the
 *    change event fires.
 *  - Each image is stored as `{ id, data, mime, name }` where `data` is the
 *    full `data:<mime>;base64,...` URL.
 *  - `removeImage(id)` filters the array by id.
 *  - Multiple images can be attached; each gets a unique id.
 *  - If the user cancels the file picker (no files selected), nothing happens.
 */
export function useImageAttachments(): UseImageAttachmentsResult {
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [rejectedImages, setRejectedImages] = useState<RejectedImage[]>([]);
  // The change handler is created once (`attachImages` has an empty dep list),
  // so it cannot read `attachedImages` directly — it would see the value from
  // the first render forever and the count cap would never bind. A ref tracks
  // the live count instead.
  const attachedCountRef = useRef(0);
  attachedCountRef.current = attachedImages.length;

  const attachImages = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';

    input.addEventListener('change', () => {
      const files = input.files;
      if (!files || files.length === 0) return;
      const readers: Promise<AttachedImage | null>[] = [];
      const rejected: RejectedImage[] = [];
      let accepted = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file) continue;
        // WS-055: screen before reading, so an oversized or non-image file is
        // never materialized as base64 in the browser at all.
        const reason = rejectionReason(file, attachedCountRef.current, accepted);
        if (reason !== null) {
          rejected.push({ name: file.name, reason });
          continue;
        }
        accepted++;
        readers.push(
          new Promise<AttachedImage | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                id: generateId(),
                data: reader.result as string,
                mime: file.type || 'image/png',
                name: file.name,
              });
            };
            // Without onerror, a corrupt/unreadable file leaves this promise
            // pending forever — Promise.all never settles and the WHOLE batch of
            // attachments is silently dropped. Resolve null and skip just this one.
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
          }),
        );
      }
      // Surface refusals instead of dropping files silently — a picker that
      // quietly ignores half a selection reads as a bug, and the user has no
      // way to learn the limit.
      setRejectedImages(rejected);
      void Promise.all(readers)
        .then((images) => {
          const valid = images.filter((img): img is AttachedImage => img !== null);
          if (valid.length > 0) setAttachedImages((current) => [...current, ...valid]);
        })
        .catch(() => {
          // Defensive: no reader rejects (errors resolve to null), but never
          // leave this detached promise without its own catch.
        });
      // Clean up the input element.
      input.remove();
    });

    document.body.append(input);
    input.click();
  }, []);

  const removeImage = useCallback((id: string) => {
    setAttachedImages((current) => current.filter((img) => img.id !== id));
  }, []);

  return {
    attachedImages,
    rejectedImages,
    attachImages,
    removeImage,
    setAttachedImages,
  };
}

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { toast } from '../Toaster.js';
import { autoFenceCode } from './code-detect.js';
import {
  type ImageAttachment,
  ImageAttachmentError,
  MAX_ATTACHED_IMAGES,
  processImageFile,
} from './image-attachments.js';
import { useUIStore } from '@/stores';

export interface PasteHintState {
  chars: number;
  lines: number;
  /** Detected language if code was auto-fenced. */
  lang?: string | undefined;
  /** If set, the fenced version can be undone via this callback. */
  undoFence?: (() => void) | undefined;
}

interface UsePasteDropOptions {
  input: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setInput: (value: string) => void;
  /** i18n error strings, resolved by the component so the hook stays free of
   *  the translation context. */
  errorText: {
    tooManyImages: (max: number) => string;
    imageProcessFailed: (name: string) => string;
    imageTooLarge: (name: string) => string;
  };
}

export function usePasteDrop({ input, textareaRef, setInput, errorText }: UsePasteDropOptions) {
  const [pasteHint, setPasteHint] = useState<PasteHintState | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);

  /** Images attached for the next message (pasted, dropped, or picked).
   *  Cleared after each submit so they aren't re-sent accidentally. The ref
   *  stays the submit-time source of truth; the state mirror drives the
   *  attachment chips. Seeded from / synced to ui-store.draftImages so a
   *  mid-compose switch to a subagent transcript doesn't silently discard
   *  attachments while the draft text survives (same contract as
   *  draftInput). */
  const pendingImagesRef = useRef<ImageAttachment[]>(useUIStore.getState().draftImages);
  const [pendingImages, setPendingImagesState] = useState<ImageAttachment[]>(() =>
    useUIStore.getState().draftImages,
  );
  const setPendingImages = (next: ImageAttachment[]) => {
    pendingImagesRef.current = next;
    setPendingImagesState(next);
    useUIStore.getState().setDraftImages(next);
  };

  /** Latest errorText without re-subscribing the paste listener on every
   *  render (the object literal is recreated by the caller each render). */
  const errorTextRef = useRef(errorText);
  errorTextRef.current = errorText;

  /** Process and append image files, enforcing the per-message count cap.
   *  Failures surface as toasts per file; successes append in order. */
  const addImageFiles = async (files: File[]): Promise<void> => {
    const err = errorTextRef.current;
    for (const file of files) {
      if (pendingImagesRef.current.length >= MAX_ATTACHED_IMAGES) {
        toast.error(err.tooManyImages(MAX_ATTACHED_IMAGES));
        return;
      }
      try {
        const attachment = await processImageFile(file);
        setPendingImages([...pendingImagesRef.current, attachment]);
      } catch (e) {
        if (e instanceof ImageAttachmentError && e.reason === 'too_large') {
          toast.error(err.imageTooLarge(file.name || 'image'));
        } else {
          toast.error(err.imageProcessFailed(file.name || 'image'));
        }
      }
    }
  };

  const removeImage = (id: string) => {
    setPendingImages(pendingImagesRef.current.filter((img) => img.id !== id));
  };

  const clearPendingImages = () => setPendingImages([]);

  /** Intercept native paste events to detect and accumulate clipboard images. */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) files.push(blob);
        }
      }
      if (files.length === 0) return;
      event.preventDefault();
      void addImageFiles(files);
    };

    textarea.addEventListener('paste', onPaste);
    return () => textarea.removeEventListener('paste', onPaste);
    // addImageFiles is stable in effect: it only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textareaRef]);

  const onDragEnter = (event: React.DragEvent<HTMLFormElement>): void => {
    // Only react to drags carrying files — text/uri-list drags from
    // other parts of the page shouldn't trip the overlay.
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    setDraggingOver(true);
  };

  const onDragOver = (event: React.DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
    // preventDefault on dragover is what makes the area a valid drop
    // target — without it the browser navigates to the file instead.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: React.DragEvent<HTMLFormElement>): void => {
    // dragleave fires when crossing child boundaries too; only clear if
    // the cursor genuinely left the form (relatedTarget outside or null).
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDraggingOver(false);
  };

  const onDrop = (event: React.DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer) return;
    const allFiles = Array.from(event.dataTransfer.files ?? []);
    if (allFiles.length === 0) {
      setDraggingOver(false);
      return;
    }
    event.preventDefault();
    setDraggingOver(false);

    // Dropped images → attach (same channel as pasted images). All of them.
    const imageFiles = allFiles.filter((f) => f.type?.startsWith('image/'));
    if (imageFiles.length > 0) {
      void addImageFiles(imageFiles);
    }
    const files = allFiles.filter((f) => !f.type?.startsWith('image/'));
    if (files.length === 0) {
      // Only image(s) were dropped — nothing to insert as @mentions.
      return;
    }

    // Non-image file drops: inform the user that the path is just the
    // basename (browsers strip the full path for security), and suggest
    // the @-mention picker to pick the correct project file.
    const basenames = files.map((f) => f.name).join(', ');
    toast.info(`Dropped file(s): ${basenames} — use @ in chat to pick the correct project path.`);
  };

  const onTextPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text) return;

    const result = autoFenceCode(text);
    if (result) {
      event.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = input.slice(0, start);
      const after = input.slice(end);
      const fenced = result.fenced;
      const next = before + fenced + after;
      setInput(next);
      const lines = text.split('\n').length;

      const undo = () => {
        const raw = before + text + after;
        setInput(raw);
        setPasteHint(null);
        requestAnimationFrame(() => {
          if (textarea) {
            textarea.focus();
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
          }
        });
      };

      setPasteHint({ chars: text.length, lines, lang: result.lang, undoFence: undo });
      setTimeout(() => setPasteHint(null), 6000);
      requestAnimationFrame(() => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
        const newPos = before.length + fenced.length;
        textarea.setSelectionRange(newPos, newPos);
      });
      return;
    }

    if (text.length > 800) {
      const lines = text.split('\n').length;
      setPasteHint({ chars: text.length, lines });
      setTimeout(() => setPasteHint(null), 4000);
    }
  };

  return {
    draggingOver,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
    onTextPaste,
    pasteHint,
    pendingImagesRef,
    pendingImages,
    addImageFiles,
    removeImage,
    clearPendingImages,
    setPasteHint,
  };
}

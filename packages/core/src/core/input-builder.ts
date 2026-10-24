import type {
  AddAttachmentInput,
  AttachmentRef,
  AttachmentStore,
} from '@wrongstack/contracts/types/attachment';
import type { ContentBlock } from '@wrongstack/contracts/types/blocks';

export interface InputBuilderOptions {
  store: AttachmentStore;
  /**
   * Pastes ≥ this many lines collapse to a `[pasted #N]` placeholder.
   * Default: 8 lines.
   */
  pasteLineThreshold?: number | undefined;
  /**
   * Pastes ≥ this many characters collapse to a placeholder regardless of
   * line count. Default: 2000 chars.
   */
  pasteCharThreshold?: number | undefined;
}

export interface InputBuilderEvent {
  /** Current display string (with placeholders, before submit). */
  display: string;
  refs: AttachmentRef[];
}

/**
 * UI-agnostic accumulator for user input. The frontend (CLI/TUI) feeds in:
 *   - typed text via `appendText()`
 *   - large pastes via `appendPaste()` → returns placeholder string
 *   - image paste via `appendImage()` → returns placeholder string
 *   - file refs (`@path`) via `appendFile()` → returns placeholder string
 *
 * On `submit()` the builder runs the display string through AttachmentStore.expand()
 * and returns the final ContentBlock[] ready for `agent.run()`.
 *
 * The builder does not know what a "line" or "key" is — that is the
 * frontend's job. It only operates on strings and byte payloads.
 */
export class InputBuilder {
  private readonly store: AttachmentStore;
  private readonly pasteLineThreshold: number;
  private readonly pasteCharThreshold: number;
  private display = '';
  private readonly refs: AttachmentRef[] = [];

  constructor(opts: InputBuilderOptions) {
    this.store = opts.store;
    this.pasteLineThreshold = opts.pasteLineThreshold ?? 8;
    this.pasteCharThreshold = opts.pasteCharThreshold ?? 2000;
  }

  get text(): string {
    return this.display;
  }

  get attachments(): AttachmentRef[] {
    return [...this.refs];
  }

  get isEmpty(): boolean {
    return this.display.trim().length === 0;
  }

  appendText(text: string): void {
    this.display += text;
  }

  /**
   * Decide whether a chunk of pasted text is "big" enough to collapse.
   * If yes, store it and append a placeholder. If no, inline it.
   * Returns the placeholder string actually appended (or `null` if inlined).
   */
  async appendPaste(text: string): Promise<string | null> {
    if (this.shouldCollapse(text)) {
      const ref = await this.store.add({
        kind: 'text',
        data: text,
        meta: { label: paragraphLabel(text) },
      });
      const placeholder = `[pasted #${ref.seq}]`;
      this.display += placeholder;
      this.refs.push(ref);
      return placeholder;
    }
    this.display += text;
    return null;
  }

  /**
   * Always collapses to `[image #N]` — images are never inlined.
   * `dataBase64` is the raw base64 payload (no data: prefix).
   */
  async appendImage(dataBase64: string, mediaType: string): Promise<string> {
    const ref = await this.store.add({
      kind: 'image',
      data: dataBase64,
      meta: { mediaType, label: `${mediaType.split('/')[1]?.toUpperCase() ?? 'IMG'}` },
    });
    const placeholder = `[image #${ref.seq}]`;
    this.display += placeholder;
    this.refs.push(ref);
    return placeholder;
  }

  async appendFile(input: AddAttachmentInput): Promise<string> {
    const ref = await this.store.add({ ...input, kind: 'file' });
    const placeholder = `[file #${ref.seq}]`;
    this.display += placeholder;
    this.refs.push(ref);
    return placeholder;
  }

  /**
   * Register-only variant of `appendPaste`. Always stores the paste and
   * returns the inline `[pasted #N, L lines]` token WITHOUT mutating
   * `display` — the caller (TUI) owns its own editable buffer as the single
   * source of truth, inserts the token there, and expands the buffer at
   * submit. The collapse decision is the caller's (it gates this call); use
   * `wouldCollapse()` for that.
   */
  async registerPaste(text: string): Promise<string> {
    const ref = await this.store.add({
      kind: 'text',
      data: text,
      meta: { label: paragraphLabel(text) },
    });
    this.refs.push(ref);
    // Split on \r\n, \r, or \n — Windows terminals often send \r-only
    // line separators in bracketed-paste mode (e.g. pasted from cmd.exe).
    const lines = text.split(/\r?\n|\r/).length;
    return `[pasted #${ref.seq}, ${lines} lines]`;
  }

  /**
   * Register-only variant of `appendImage` — see `registerPaste`. Returns a
   * seq-keyed `[image #N, LABEL]` token; does not touch `display`.
   */
  async registerImage(dataBase64: string, mediaType: string): Promise<string> {
    const label = `${mediaType.split('/')[1]?.toUpperCase() ?? 'IMG'}`;
    const ref = await this.store.add({
      kind: 'image',
      data: dataBase64,
      meta: { mediaType, label },
    });
    this.refs.push(ref);
    return `[image #${ref.seq}, ${label}]`;
  }

  /**
   * Register-only variant of `appendFile` — see `registerPaste`. Returns a
   * path-keyed `[file:<path>]` token (resolved by path at expand time); does
   * not touch `display`. The path is read from `meta.filename` (falling back
   * to `meta.label`).
   */
  async registerFile(input: AddAttachmentInput): Promise<string> {
    const ref = await this.store.add({ ...input, kind: 'file' });
    this.refs.push(ref);
    const path = ref.meta.filename ?? ref.meta.label ?? String(ref.seq);
    return `[file:${path}]`;
  }

  /**
   * Register a PDF (see `registerPaste`). `data` is the file as base64 and
   * `text` its extracted text, which models without PDF input receive. The
   * token is path-keyed like `registerFile`'s, so a PDF picked with `@` looks
   * like any other file in the buffer.
   */
  async registerDocument(input: {
    data: string;
    text: string;
    filename: string;
    pages?: number | undefined;
  }): Promise<string> {
    const ref = await this.store.add({
      kind: 'document',
      data: input.data,
      text: input.text,
      meta: {
        filename: input.filename,
        label: input.filename,
        mediaType: 'application/pdf',
        ...(input.pages !== undefined ? { pages: input.pages } : {}),
      },
    });
    this.refs.push(ref);
    return `[file:${input.filename}]`;
  }

  /**
   * Whether `appendPaste(text)` would collapse the text to a placeholder
   * (rather than inlining it). Lets a frontend decide where to route a paste
   * — e.g. collapsed pastes become a pill, while inlined ones can be shown
   * in the editable input row — without calling `appendPaste` first (which
   * mutates the display buffer).
   */
  wouldCollapse(text: string): boolean {
    return this.shouldCollapse(text);
  }

  /** Reset display and ref list. Does NOT clear the store itself. */
  reset(): void {
    this.display = '';
    this.refs.length = 0;
  }

  /**
   * Resolve the current display string into ContentBlock[]. Empty
   * input returns an empty array — caller decides what to do.
   */
  async submit(): Promise<ContentBlock[]> {
    const text = this.display;
    this.reset();
    return text ? this.store.expand(text) : [];
  }

  private shouldCollapse(text: string): boolean {
    if (text.length >= this.pasteCharThreshold) return true;
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      // \n (10) is always a line break.
      // \r (13) is a line break only when NOT followed by \n (Mac-style).
      // \r\n sequences are counted once by the \n check on the next iteration.
      if (c === 10) lines++;
      else if (c === 13 && text.charCodeAt(i + 1) !== 10) lines++;
      if (lines >= this.pasteLineThreshold) return true;
    }
    return false;
  }
}

function paragraphLabel(text: string): string {
  // Split on \r\n, \r, or \n — handles Windows (\r\n), Unix (\n), and
  // legacy Mac / bracketed-paste \r-only separators.
  const lines = text.split(/\r?\n|\r/).length;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 1024) return `${lines} lines, ${bytes} B`;
  return `${lines} lines, ${(bytes / 1024).toFixed(1)} KB`;
}

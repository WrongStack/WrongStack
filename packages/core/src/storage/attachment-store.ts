import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import type {
  AddAttachmentInput,
  Attachment,
  AttachmentKind,
  AttachmentRef,
  AttachmentStore,
} from '../types/attachment.js';
import type { ContentBlock } from '../types/blocks.js';

export interface AttachmentStoreOptions {
  /**
   * Directory for spooling payloads larger than `spoolThresholdBytes`.
   * When omitted, all payloads stay in memory.
   */
  spoolDir?: string | undefined;
  spoolThresholdBytes?: number | undefined;
}

const DEFAULT_SPOOL_THRESHOLD = 256 * 1024; // 256 KB
// Two placeholder shapes:
//   - seq-keyed `[<kind> #<seq>…]` — kind is `pasted` / `image` / `file`. A
//     cosmetic suffix after the seq (e.g. `, 123 lines`) is tolerated so the
//     TUI can render `[pasted #1, 123 lines]` while still resolving by seq.
//   - path-keyed `[file:<path>]` — resolves to the most recent file ref whose
//     stored path matches, so the TUI can show a human-readable file chip.
const PLACEHOLDER_RE = /\[(pasted|image|file) #(\d+)[^\]]*\]|\[file:([^\]]+)\]/g;

/**
 * In-memory attachment store with optional disk spool. Placeholder syntax
 * is `[<kind> #<seq>]` (seq-keyed) or `[file:<path>]` (path-keyed) where kind
 * is `pasted` / `image` / `file`. Unknown placeholders are passed through
 * as-is so users can write that literal text without losing it.
 */
export class DefaultAttachmentStore implements AttachmentStore {
  private readonly items = new Map<string, Attachment>();
  private readonly refs: AttachmentRef[] = [];
  private nextSeq: Record<AttachmentKind, number> = { text: 0, image: 0, file: 0 };
  private readonly spoolDir: string | undefined;
  private readonly spoolThreshold: number;

  constructor(opts: AttachmentStoreOptions = {}) {
    this.spoolDir = opts.spoolDir;
    this.spoolThreshold = opts.spoolThresholdBytes ?? DEFAULT_SPOOL_THRESHOLD;
  }

  async add(input: AddAttachmentInput): Promise<AttachmentRef> {
    const seq = ++this.nextSeq[input.kind];
    const id = `${kindPrefix(input.kind)}-${seq}-${randomBytes(3).toString('hex')}`;
    const bytes = Buffer.byteLength(input.data, input.kind === 'image' ? 'base64' : 'utf8');
    let spooledPath: string | undefined;
    let data: string | undefined = input.data;
    if (this.spoolDir && bytes >= this.spoolThreshold) {
      await fsp.mkdir(this.spoolDir, { recursive: true });
      spooledPath = path.join(this.spoolDir, `${id}.bin`);
      // atomicWrite: torn spool would silently corrupt the attachment;
      // the user would see garbled output the next time it's expanded.
      await atomicWrite(spooledPath, input.data, {
        encoding: input.kind === 'image' ? 'base64' : 'utf8',
      });
      data = undefined;
    }
    const att: Attachment = {
      id,
      kind: input.kind,
      meta: input.meta ?? {},
      data,
      path: spooledPath,
      bytes,
      createdAt: new Date().toISOString(),
    };
    this.items.set(id, att);
    const ref: AttachmentRef = { id, kind: input.kind, seq, meta: att.meta };
    this.refs.push(ref);
    return ref;
  }

  async get(id: string): Promise<Attachment | undefined> {
    return this.items.get(id);
  }

  list(): AttachmentRef[] {
    return [...this.refs];
  }

  async expand(text: string): Promise<ContentBlock[]> {
    const matches = [...text.matchAll(PLACEHOLDER_RE)];
    if (matches.length === 0) return text ? [{ type: 'text', text }] : [];
    const blocks: ContentBlock[] = [];
    let lastIndex = 0;
    for (const m of matches) {
      const idx = m.index ?? 0;
      const before = text.slice(lastIndex, idx);
      if (before) blocks.push({ type: 'text', text: before });
      let ref: AttachmentRef | undefined;
      if (m[3] !== undefined) {
        // Path-keyed `[file:<path>]` — most recent matching file ref wins.
        const wantPath = m[3];
        const norm = (s?: string) => s?.replace(/\\/g, '/');
        ref = findLast(this.refs, (r) => r.kind === 'file' && norm(refPath(r)) === norm(wantPath));
      } else {
        const kind = prefixToKind(m[1] as string);
        const seq = Number(m[2]);
        ref = this.refs.find((r) => r.kind === kind && r.seq === seq);
      }
      const att = ref ? this.items.get(ref.id) : undefined;
      if (!att) {
        blocks.push({ type: 'text', text: m[0] });
      } else {
        blocks.push(await this.toBlock(att));
      }
      lastIndex = idx + m[0].length;
    }
    const tail = text.slice(lastIndex);
    if (tail) blocks.push({ type: 'text', text: tail });
    return mergeAdjacentText(blocks);
  }

  async clear(): Promise<void> {
    // Unlink any spooled files so we don't leak disk space.
    if (this.spoolDir) {
      const toDelete: string[] = [];
      for (const att of this.items.values()) {
        if (att.path) toDelete.push(att.path);
      }
      /* v8 ignore next -- best-effort: unlink of a just-spooled file does not reject */
      await Promise.all(toDelete.map((p) => fsp.unlink(p).catch(() => undefined)));
    }
    this.items.clear();
    this.refs.length = 0;
    this.nextSeq = { text: 0, image: 0, file: 0 };
  }

  private async toBlock(att: Attachment): Promise<ContentBlock> {
    if (att.kind === 'image') {
      const data =
        att.data ?? (att.path ? await fsp.readFile(att.path, { encoding: 'base64' }) : '');
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.meta.mediaType ?? 'image/png',
          data,
        },
      };
    }
    const raw = att.data ?? (att.path ? await fsp.readFile(att.path, 'utf8') : '');
    const label = att.meta.filename ? `<file path="${att.meta.filename}">` : '<pasted>';
    const close = att.meta.filename ? '</file>' : '</pasted>';
    return { type: 'text', text: `${label}\n${raw}\n${close}` };
  }
}

function kindPrefix(kind: AttachmentKind): string {
  return kind === 'text' ? 'pasted' : kind;
}

function prefixToKind(prefix: string): AttachmentKind {
  if (prefix === 'pasted') return 'text';
  if (prefix === 'image') return 'image';
  return 'file';
}

/** Path a file ref was registered under, for `[file:<path>]` lookup. */
function refPath(ref: AttachmentRef): string | undefined {
  return ref.meta.filename ?? ref.meta.label;
}

/** Last element matching the predicate (Node < 20 lacks Array.findLast). */
function findLast<T>(arr: readonly T[], pred: (v: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i] as T)) return arr[i];
  }
  return undefined;
}

function mergeAdjacentText(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.type === 'text' && prev && prev.type === 'text') {
      prev.text += b.text;
    } else {
      out.push(b);
    }
  }
  return out;
}

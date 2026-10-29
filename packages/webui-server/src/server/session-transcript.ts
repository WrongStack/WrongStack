import { createHash } from 'node:crypto';
import type { ContentBlock, Message } from '@wrongstack/contracts/types';

const TEXT_CHUNK = 16000;
type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw Error('Transcript offset or page size is invalid.');
  return value;
}
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking':
      return block.thinking;
    case 'tool_result':
      return block.content;
    case 'document':
      return block.text;
    case 'tool_use':
      return `${block.name} ${JSON.stringify(block.input)}`;
    case 'image':
      return '';
  }
}
function blocks(message: Message): ContentBlock[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;
}
export function transcriptRevision(messages: readonly Message[]) {
  const hash = createHash('sha256');
  for (const message of messages)
    hash
      .update(
        JSON.stringify([
          message.role,
          message.origin,
          message.authoredLength,
          message.ts,
          message.content,
        ]),
      )
      .update('\n');
  return hash.digest('hex');
}
/** Search the retained projection, never superseded journal events or attachment bytes. */
export function findTranscriptMatches(messages: readonly Message[], query: string, role: string) {
  const hits: { messageIndex: number; role: string; excerpt: string }[] = [];
  let matching = 0;
  messages.forEach((message, messageIndex) => {
    if (role && message.role !== role) return;
    for (const block of blocks(message)) {
      const text = blockText(block);
      const match = text.toLowerCase().indexOf(query);
      if (match < 0) continue;
      matching++;
      if (hits.length < 3)
        hits.push({
          messageIndex,
          role: message.role,
          excerpt: textWindow(text, Math.max(0, match - 100), 360).text,
        });
      break;
    }
  });
  return { matching, hits };
}
function textWindow(text: string, offset: number, cap = TEXT_CHUNK) {
  if (offset > text.length) throw Error('Transcript text offset is outside this block.');
  if (
    offset > 0 &&
    /[\uDC00-\uDFFF]/.test(text[offset] ?? '') &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!)
  )
    offset--;
  let end = Math.min(text.length, offset + cap);
  if (end < text.length && end > offset && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return {
    text: text.slice(offset, end),
    textOffset: offset,
    nextTextOffset: end < text.length ? end : null,
    totalChars: text.length,
  };
}
function boundedInput(value: unknown, budget: { left: number }, depth = 0): unknown {
  if (budget.left <= 0 || depth > 5) return '(additional input omitted)';
  budget.left -= 32;
  if (typeof value === 'string') {
    const size = Math.min(4000, budget.left);
    budget.left -= size;
    return value.length > size ? value.slice(0, size) + '…' : value;
  }
  if (Array.isArray(value))
    return value.slice(0, 30).map((item) => boundedInput(item, budget, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 30)
        .map(([key, item]) => [key.slice(0, 200), boundedInput(item, budget, depth + 1)]),
    );
  return value;
}
function projectBlock(block: ContentBlock, index: number, budget: { left: number }, query: string) {
  const common = { index, type: block.type };
  if (block.type === 'image')
    return { ...common, mediaType: block.source.media_type ?? 'image', binaryOmitted: true };
  if (block.type === 'tool_use')
    return {
      ...common,
      name: block.name.slice(0, 200),
      toolId: block.id.slice(0, 200),
      input: boundedInput(block.input, budget),
      inputPreview: true,
    };
  const text = blockText(block);
  const match = query ? text.toLowerCase().indexOf(query) : -1;
  const offset = match > TEXT_CHUNK ? Math.max(0, match - 300) : 0;
  const window = textWindow(text, offset, Math.min(TEXT_CHUNK, Math.max(0, budget.left)));
  budget.left -= window.text.length;
  return {
    ...common,
    ...window,
    ...(block.type === 'tool_result'
      ? {
          toolId: block.tool_use_id.slice(0, 200),
          name: block.name?.slice(0, 200),
          isError: block.is_error === true,
        }
      : {}),
    ...(block.type === 'document'
      ? { name: block.name?.slice(0, 200), pages: block.pages, binaryOmitted: true }
      : {}),
  };
}
export function projectSessionTranscript(messages: readonly Message[], raw: unknown) {
  const options = record(raw),
    offset = integer(options['offset'], 0, Number.MAX_SAFE_INTEGER),
    limit = integer(options['limit'], 10, 25);
  if (limit < 1) throw Error('Transcript page size must be at least one.');
  const query = typeof options['query'] === 'string' ? options['query'].trim().toLowerCase() : '';
  if (query.length > 500) throw Error('Transcript search is limited to 500 characters.');
  const role = typeof options['role'] === 'string' ? options['role'] : '';
  if (!['', 'user', 'assistant', 'system'].includes(role))
    throw Error('Transcript role filter is invalid.');
  const revision = transcriptRevision(messages);
  if (options['expectedRevision'] !== undefined && options['expectedRevision'] !== revision)
    throw Error('The transcript changed. Refresh before loading more history.');
  const matches = messages.flatMap((message, index) =>
    (!role || message.role === role) &&
    (!query || blocks(message).some((block) => blockText(block).toLowerCase().includes(query)))
      ? [index]
      : [],
  );
  if (offset > matches.length) throw Error('Transcript page is outside the current results.');
  const budget = { left: 60000 };
  return {
    revision,
    total: messages.length,
    matching: matches.length,
    offset,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    messages: matches.slice(offset, offset + limit).map((index) => {
      const message = messages[index]!;
      return {
        index,
        role: message.role,
        origin: message.origin,
        authoredLength: message.authoredLength,
        ts: message.ts,
        blocks: blocks(message)
          .slice(0, 100)
          .map((block, blockIndex) => projectBlock(block, blockIndex, budget, query)),
        omittedBlocks: Math.max(0, blocks(message).length - 100),
      };
    }),
  };
}
/**
 * The blocks of one message from `blockOffset`, a hundred at a time, projected like a transcript
 * page (bounded text and tool inputs, no media bytes). Reaches blocks a page leaves out.
 */
export function readSessionTranscriptBlocks(messages: readonly Message[], raw: unknown) {
  const options = record(raw);
  const revision = transcriptRevision(messages);
  if (options['expectedRevision'] !== revision)
    throw Error('The transcript changed. Refresh before reading more of this message.');
  const messageIndex = integer(options['messageIndex'], -1, Number.MAX_SAFE_INTEGER);
  const message = messages[messageIndex];
  if (!message) throw Error('This transcript message does not exist.');
  const all = blocks(message);
  const blockOffset = integer(options['blockOffset'], 0, Number.MAX_SAFE_INTEGER);
  if (blockOffset >= all.length) throw Error('These blocks are outside the message.');
  const budget = { left: 60000 };
  return {
    revision,
    messageIndex,
    blockOffset,
    blocks: all
      .slice(blockOffset, blockOffset + 100)
      .map((block, at) => projectBlock(block, blockOffset + at, budget, '')),
    nextBlockOffset: blockOffset + 100 < all.length ? blockOffset + 100 : null,
  };
}
const RASTER_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Base64 characters for about 4 MiB of image bytes. */
const MAX_IMAGE_BASE64 = Math.ceil((4 * 1024 * 1024) / 3) * 4;

/**
 * One retained image, read only on explicit request for a viewer. Transcript pages never carry
 * image bytes; this returns a single raster image stored in the session (no URL is fetched,
 * markup formats such as SVG are refused) within a bounded size.
 */
export function readSessionTranscriptImage(messages: readonly Message[], raw: unknown) {
  const options = record(raw);
  const revision = transcriptRevision(messages);
  if (options['expectedRevision'] !== revision)
    throw Error('The transcript changed. Refresh before reading this image.');
  const messageIndex = integer(options['messageIndex'], -1, Number.MAX_SAFE_INTEGER),
    blockIndex = integer(options['blockIndex'], -1, Number.MAX_SAFE_INTEGER);
  const message = messages[messageIndex],
    block = message && blocks(message)[blockIndex];
  if (block?.type !== 'image') throw Error('This transcript block is not an image.');
  const { source } = block;
  if (source.type !== 'base64' || typeof source.data !== 'string')
    throw Error('This image is not stored in the session, so it cannot be shown.');
  const mediaType = (source.media_type ?? '').toLowerCase();
  if (!RASTER_IMAGES.has(mediaType))
    throw Error('This image is not a raster image that can be shown.');
  const data = source.data.replace(/\s+/g, '');
  if (data.length > MAX_IMAGE_BASE64) throw Error('This image is too large to show here.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw Error('The stored image data is not valid.');
  return {
    revision,
    messageIndex,
    blockIndex,
    mediaType,
    dataUrl: `data:${mediaType};base64,${data}`,
  };
}
export function readSessionTranscriptBlock(messages: readonly Message[], raw: unknown) {
  const options = record(raw);
  const revision = transcriptRevision(messages);
  if (options['expectedRevision'] !== revision)
    throw Error('The transcript changed. Refresh before reading this message.');
  const messageIndex = integer(options['messageIndex'], -1, Number.MAX_SAFE_INTEGER),
    blockIndex = integer(options['blockIndex'], -1, Number.MAX_SAFE_INTEGER);
  const message = messages[messageIndex],
    block = message && blocks(message)[blockIndex];
  if (!block || block.type === 'image' || block.type === 'tool_use')
    throw Error('This transcript block has no readable text.');
  return {
    revision,
    messageIndex,
    blockIndex,
    ...textWindow(blockText(block), integer(options['offset'], 0, Number.MAX_SAFE_INTEGER)),
  };
}

import type { ContentBlock, Message } from '@wrongstack/contracts/types';
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  base64DecodedBytes,
  isAllowedImageMediaType,
  isValidImageBase64,
  MAX_INCOMING_IMAGE_BYTES,
} from '@wrongstack/core/utils';
import type { ContextEditorValidationError } from './context-editor-types.js';

const MAX_MESSAGE_COUNT_GROWTH = 10;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_STRING_LENGTH = 8 * 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return MAX_PAYLOAD_BYTES + 1;
  }
}

export function error(
  errors: ContextEditorValidationError[],
  path: string,
  code: string,
  message: string,
): void {
  errors.push({ path, code, message });
}

function isMessageRole(value: unknown): value is Message['role'] {
  return value === 'user' || value === 'assistant' || value === 'system';
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

function validateCacheControl(
  value: unknown,
  path: string,
  errors: ContextEditorValidationError[],
): { type: 'ephemeral' } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value['type'] !== 'ephemeral') {
    error(errors, path, 'INVALID_CACHE_CONTROL', 'cache_control must be { type: "ephemeral" }.');
    return undefined;
  }
  return { type: 'ephemeral' };
}

function validateProviderMeta(
  value: unknown,
  path: string,
  errors: ContextEditorValidationError[],
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainJsonObject(value)) {
    error(errors, path, 'INVALID_PROVIDER_META', 'providerMeta must be a JSON object.');
    return undefined;
  }
  return value;
}

function validateBlock(
  value: unknown,
  path: string,
  errors: ContextEditorValidationError[],
): ContentBlock | undefined {
  if (!isRecord(value)) {
    error(errors, path, 'INVALID_BLOCK', 'Content block must be an object.');
    return undefined;
  }
  const type = value['type'];
  switch (type) {
    case 'text': {
      const text = value['text'];
      if (typeof text !== 'string') {
        error(errors, `${path}/text`, 'INVALID_TEXT', 'Text block text must be a string.');
        return undefined;
      }
      if (text.length > MAX_STRING_LENGTH) {
        error(errors, `${path}/text`, 'TEXT_TOO_LARGE', 'Text block is too large.');
        return undefined;
      }
      const cacheControl = validateCacheControl(
        value['cache_control'],
        `${path}/cache_control`,
        errors,
      );
      return cacheControl
        ? { type: 'text', text, cache_control: cacheControl }
        : { type: 'text', text };
    }
    case 'tool_use': {
      const id = value['id'];
      const name = value['name'];
      const input = value['input'];
      if (typeof id !== 'string' || id.length === 0) {
        error(
          errors,
          `${path}/id`,
          'INVALID_TOOL_USE_ID',
          'tool_use.id must be a non-empty string.',
        );
      }
      if (typeof name !== 'string' || name.length === 0) {
        error(
          errors,
          `${path}/name`,
          'INVALID_TOOL_NAME',
          'tool_use.name must be a non-empty string.',
        );
      }
      if (!isPlainJsonObject(input)) {
        error(errors, `${path}/input`, 'INVALID_TOOL_INPUT', 'tool_use.input must be an object.');
      }
      const providerMeta = validateProviderMeta(
        value['providerMeta'],
        `${path}/providerMeta`,
        errors,
      );
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        typeof name !== 'string' ||
        name.length === 0 ||
        !isPlainJsonObject(input)
      ) {
        return undefined;
      }
      return providerMeta === undefined
        ? { type: 'tool_use', id, name, input }
        : { type: 'tool_use', id, name, input, providerMeta };
    }
    case 'tool_result': {
      const toolUseId = value['tool_use_id'];
      const name = value['name'];
      const content = value['content'];
      const isError = value['is_error'];
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) {
        error(
          errors,
          `${path}/tool_use_id`,
          'INVALID_TOOL_RESULT_ID',
          'tool_result.tool_use_id must be a non-empty string.',
        );
      }
      if (name !== undefined && typeof name !== 'string') {
        error(
          errors,
          `${path}/name`,
          'INVALID_TOOL_RESULT_NAME',
          'tool_result.name must be a string.',
        );
      }
      if (typeof content !== 'string') {
        error(
          errors,
          `${path}/content`,
          'INVALID_TOOL_RESULT_CONTENT',
          'tool_result.content must be a string.',
        );
      } else if (content.length > MAX_STRING_LENGTH) {
        error(
          errors,
          `${path}/content`,
          'TOOL_RESULT_TOO_LARGE',
          'tool_result.content is too large.',
        );
      }
      if (isError !== undefined && typeof isError !== 'boolean') {
        error(
          errors,
          `${path}/is_error`,
          'INVALID_TOOL_RESULT_ERROR',
          'tool_result.is_error must be boolean.',
        );
      }
      if (typeof toolUseId !== 'string' || toolUseId.length === 0 || typeof content !== 'string')
        return undefined;
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof isError === 'boolean' ? { is_error: isError } : {}),
      };
    }
    case 'image': {
      // WS-032. This case used to check only the *types* of the source fields,
      // never their values — so it was a second image-ingest path that bypassed
      // every control `parseIncomingImages` enforces on the normal one: the
      // media-type allowlist, the base64 alphabet check, and the 8 MB cap.
      //
      // It was also the only way a `type: 'url'` image could enter WebUI
      // history at all (`parseIncomingImages` always emits base64), and the
      // SSRF guard for url-sourced images lives in `routeImagesForModel`, which
      // runs on the new-message path only — never on replayed history. So an
      // arbitrary URL written here went straight to the provider wire
      // (`to-openai` / `to-responses` both forward `source.url` verbatim).
      const source = value['source'];
      if (!isRecord(source)) {
        error(errors, `${path}/source`, 'INVALID_IMAGE_SOURCE', 'image.source must be an object.');
        return undefined;
      }
      const sourceType = source['type'];
      if (sourceType !== 'base64' && sourceType !== 'url') {
        error(
          errors,
          `${path}/source/type`,
          'INVALID_IMAGE_SOURCE_TYPE',
          'image.source.type must be base64 or url.',
        );
        return undefined;
      }
      const mediaType = source['media_type'];
      const data = source['data'];
      const url = source['url'];
      if (mediaType !== undefined && typeof mediaType !== 'string') {
        error(
          errors,
          `${path}/source/media_type`,
          'INVALID_IMAGE_MEDIA_TYPE',
          'image.source.media_type must be a string.',
        );
        return undefined;
      }
      // `media_type` is interpolated into a `data:` URL by the OpenAI and
      // Responses wires, so an unvalidated value is header injection into that
      // URL, not just a wrong label.
      if (typeof mediaType === 'string' && !isAllowedImageMediaType(mediaType)) {
        error(
          errors,
          `${path}/source/media_type`,
          'UNSUPPORTED_IMAGE_MEDIA_TYPE',
          `image.source.media_type must be one of: ${[...ALLOWED_IMAGE_MEDIA_TYPES].join(', ')}.`,
        );
        return undefined;
      }

      if (sourceType === 'base64') {
        if (typeof data !== 'string' || data.length === 0) {
          error(
            errors,
            `${path}/source/data`,
            'INVALID_IMAGE_DATA',
            'image.source.data must be a non-empty string for a base64 source.',
          );
          return undefined;
        }
        if (!isValidImageBase64(data)) {
          error(
            errors,
            `${path}/source/data`,
            'INVALID_IMAGE_DATA',
            'image.source.data is not valid base64.',
          );
          return undefined;
        }
        if (base64DecodedBytes(data) > MAX_INCOMING_IMAGE_BYTES) {
          error(
            errors,
            `${path}/source/data`,
            'IMAGE_TOO_LARGE',
            `image.source.data exceeds the ${MAX_INCOMING_IMAGE_BYTES / (1024 * 1024)} MB limit.`,
          );
          return undefined;
        }
        return {
          type: 'image',
          source: {
            type: 'base64',
            ...(typeof mediaType === 'string' ? { media_type: mediaType } : {}),
            data,
          },
        };
      }

      if (typeof url !== 'string' || url.length === 0) {
        error(
          errors,
          `${path}/source/url`,
          'INVALID_IMAGE_URL',
          'image.source.url must be a non-empty string for a url source.',
        );
        return undefined;
      }
      error(
        errors,
        `${path}/source/url`,
        'UNSAFE_IMAGE_URL',
        'URL image sources are not allowed in context editor proposals; use an ingested base64 image.',
      );
      return undefined;
    }
    case 'thinking': {
      const thinking = value['thinking'];
      const signature = value['signature'];
      if (typeof thinking !== 'string') {
        error(
          errors,
          `${path}/thinking`,
          'INVALID_THINKING',
          'thinking.thinking must be a string.',
        );
        return undefined;
      }
      if (signature !== undefined && typeof signature !== 'string') {
        error(
          errors,
          `${path}/signature`,
          'INVALID_THINKING_SIGNATURE',
          'thinking.signature must be a string.',
        );
      }
      const providerMeta = validateProviderMeta(
        value['providerMeta'],
        `${path}/providerMeta`,
        errors,
      );
      return {
        type: 'thinking',
        thinking,
        ...(typeof signature === 'string' ? { signature } : {}),
        ...(providerMeta === undefined ? {} : { providerMeta }),
      };
    }
    default:
      error(
        errors,
        `${path}/type`,
        'UNKNOWN_BLOCK_TYPE',
        `Unknown content block type: ${String(type)}`,
      );
      return undefined;
  }
}

export function validateContextEditorMessages(
  value: unknown,
  currentMessageCount = 0,
): { messages: Message[]; errors: ContextEditorValidationError[] } {
  const errors: ContextEditorValidationError[] = [];
  const messages: Message[] = [];
  if (!Array.isArray(value)) {
    error(errors, '/messages', 'INVALID_MESSAGES', 'messages must be an array.');
    return { messages, errors };
  }
  if (value.length > currentMessageCount + MAX_MESSAGE_COUNT_GROWTH) {
    error(
      errors,
      '/messages',
      'TOO_MANY_MESSAGES',
      'Context editor is deletion-oriented; proposed message count grew too much.',
    );
  }
  if (jsonByteLength(value) > MAX_PAYLOAD_BYTES) {
    error(errors, '/messages', 'PAYLOAD_TOO_LARGE', 'Context editor payload is too large.');
  }
  value.forEach((item, index) => {
    const path = `/messages/${index}`;
    if (!isRecord(item)) {
      error(errors, path, 'INVALID_MESSAGE', 'Message must be an object.');
      return;
    }
    const role = item['role'];
    if (!isMessageRole(role)) {
      error(
        errors,
        `${path}/role`,
        'INVALID_ROLE',
        'Message role must be user, assistant, or system.',
      );
      return;
    }
    const rawContent = item['content'];
    let content: Message['content'] | undefined;
    if (typeof rawContent === 'string') {
      if (rawContent.length > MAX_STRING_LENGTH) {
        error(errors, `${path}/content`, 'CONTENT_TOO_LARGE', 'Message content is too large.');
        return;
      }
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      const blocks: ContentBlock[] = [];
      rawContent.forEach((block, blockIndex) => {
        const parsed = validateBlock(block, `${path}/content/${blockIndex}`, errors);
        if (parsed) blocks.push(parsed);
      });
      content = blocks;
    } else {
      error(
        errors,
        `${path}/content`,
        'INVALID_CONTENT',
        'Message content must be a string or content block array.',
      );
      return;
    }
    const ts = item['ts'];
    if (ts !== undefined) {
      if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) {
        error(
          errors,
          `${path}/ts`,
          'INVALID_TIMESTAMP',
          'Message ts must be an ISO-like timestamp string.',
        );
        return;
      }
    }
    messages.push({ role, content, ...(typeof ts === 'string' ? { ts } : {}) });
  });
  return { messages, errors };
}

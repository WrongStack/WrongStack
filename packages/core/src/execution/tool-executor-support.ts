import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scrubErrorText } from '../security/error-sanitize.js';
import { FetchError, ToolValidationError, WrongStackError } from '../types/errors.js';
import type { ToolErrorCategory } from '../types/tool.js';
import { ToolErrorCategory as ToolErrorCategoryEnum } from '../types/tool.js';
import type { ToolExecutorOptions } from '../types/tool-executor.js';
import { MALFORMED_ARG_MARKERS } from '../types/tool-markers.js';
import { expectDefined } from '../utils/expect-defined.js';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';

const TOOL_OUTPUT_ARTIFACT_THRESHOLD_BYTES = 24 * 1024;
const TOOL_OUTPUT_ARTIFACT_PREVIEW_BYTES = 6 * 1024;
const TOOL_OUTPUT_ARTIFACT_OMISSION = '\n…[artifact middle omitted]…\n';

export function clampTimeoutMs(timeoutMs: number, maxTimeoutMs: number): number {
  const fallback = 300_000;
  const finiteTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback;
  const finiteMax = Number.isFinite(maxTimeoutMs) && maxTimeoutMs > 0 ? maxTimeoutMs : fallback;
  return Math.max(1, Math.min(finiteTimeout, finiteMax));
}

/** Normalize an AbortSignal reason (Error | string | undefined) to an Error. */
export function abortReasonToError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === 'string' ? reason : 'tool timeout');
}

export function hasMalformedArguments(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const obj = input as Record<string, unknown>;
  // The sentinel is the *only* key when wrapping occurred - a real tool call
  // that legitimately uses a key named e.g. `_raw` will carry other keys too.
  const keys = Object.keys(obj);
  return keys.length === 1 && MALFORMED_ARG_MARKERS.includes(keys[0] as never);
}

export function extractMalformedRaw(input: unknown): string | undefined {
  if (!hasMalformedArguments(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const value = obj[expectDefined(Object.keys(obj)[0])];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Upper bound on `detail`; it lands in a durable log line, not a transcript. */
const MAX_VALIDATION_DETAIL = 300;

/**
 * Describe WHICH validation failed.
 *
 * Both validation branches used to hardcode `detail: 'validation'` — a verbatim
 * restatement of the category it travels beside, so the log line carried no
 * information the category did not. Every other branch of the classifier puts
 * something identifying in `detail` (the errno code, `'aborted'`); only this
 * one degraded. Field evidence: ten `tool execution failed` lines for the
 * `edit` tool in one day, each `errorCategory: 'validation'` /
 * `errorDetail: 'validation'`, none of them diagnosable after the fact.
 *
 * `ToolValidationError` carries both a message and a `context.field` naming
 * what failed. Both were discarded at exactly the point they would have been
 * recorded.
 *
 * Scrubbed and capped on the way out: this is a durable log, and a validation
 * message can quote the offending argument — the same reasoning that put
 * `scrubErrorText` on the CLI fatal path (H5). `scrubErrorText` keeps the text
 * and removes credentials and the home directory, so there is no
 * debuggability trade.
 */
function validationDetail(err: Error): string {
  const field =
    err instanceof WrongStackError && typeof err.context?.['field'] === 'string'
      ? err.context['field']
      : undefined;
  const described = field ? `${field}: ${err.message}` : err.message;
  const safe = scrubErrorText(described).trim();
  // Never return an empty detail: a caller reading `errorDetail` must be able
  // to distinguish "no message" from "field missing" without a special case.
  if (!safe) return 'validation';
  return safe.length > MAX_VALIDATION_DETAIL ? `${safe.slice(0, MAX_VALIDATION_DETAIL)}…` : safe;
}

/**
 * Classify a tool execution error into a structured ToolErrorCategory.
 * Used for observability (span attributes) and retry strategy decisions.
 */
export function classifyToolError(err: unknown): {
  category: ToolErrorCategory;
  retryable: boolean;
  detail?: string;
} {
  // AbortError - user cancellation, never retry
  if (err instanceof Error && err.name === 'AbortError') {
    return { category: ToolErrorCategoryEnum.FATAL, retryable: false, detail: 'aborted' };
  }

  // Node.js ErrnoException with system error codes
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    switch (code) {
      case 'ETIMEDOUT':
      case 'ECONNRESET':
      case 'ECONNREFUSED':
      case 'ENETUNREACH':
      case 'EHOSTUNREACH':
        return { category: ToolErrorCategoryEnum.TRANSIENT, retryable: true, detail: code };
      case 'ENOENT':
      case 'ENOTDIR':
        return { category: ToolErrorCategoryEnum.NOT_FOUND, retryable: false, detail: code };
      case 'EACCES':
      case 'EPERM':
        return { category: ToolErrorCategoryEnum.PERMISSION, retryable: false, detail: code };
      case 'EBUSY':
      case 'EMFILE':
      case 'ENFILE':
        return { category: ToolErrorCategoryEnum.TRANSIENT, retryable: true, detail: code };
    }
  }

  if (err instanceof FetchError) {
    return httpStatusToCategory(err.status);
  }
  if (err instanceof Error && 'response' in err) {
    const response = (err as { response: { status?: number } }).response;
    const status = response?.status;
    if (status !== undefined) {
      return httpStatusToCategory(status);
    }
  }

  if (err instanceof ToolValidationError) {
    return {
      category: ToolErrorCategoryEnum.VALIDATION,
      retryable: false,
      detail: validationDetail(err),
    };
  }
  if (err instanceof Error && err.message.includes('validation')) {
    return {
      category: ToolErrorCategoryEnum.VALIDATION,
      retryable: false,
      detail: validationDetail(err),
    };
  }

  if (err instanceof WrongStackError) {
    const wse = err as WrongStackError;
    const category =
      wse.severity === 'warning' ? ToolErrorCategoryEnum.TRANSIENT : ToolErrorCategoryEnum.FATAL;
    return {
      category,
      retryable: wse.recoverable,
      detail: `${wse.code} [${wse.subsystem}]`,
    };
  }

  // Scrubbed for the same reason as the validation branch above: this is an
  // arbitrary unclassified error, so it is the MOST likely of all the branches
  // to carry a provider response, a connection string or an echoed header —
  // and it went to the durable log verbatim. Slice after scrubbing, never
  // before: truncating first can cut a credential in half and leave the
  // leading half past the scrubber's pattern.
  const raw = err instanceof Error ? err.message : String(err);
  return {
    category: ToolErrorCategoryEnum.FATAL,
    retryable: false,
    detail: scrubErrorText(raw).slice(0, 100),
  };
}

function httpStatusToCategory(status: number): {
  category: ToolErrorCategory;
  retryable: boolean;
  detail: string;
} {
  if (status === 429 || status === 503 || status === 502 || status === 504) {
    return { category: ToolErrorCategoryEnum.TRANSIENT, retryable: true, detail: `HTTP ${status}` };
  }
  if (status === 404 || status === 410) {
    return {
      category: ToolErrorCategoryEnum.NOT_FOUND,
      retryable: false,
      detail: `HTTP ${status}`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      category: ToolErrorCategoryEnum.PERMISSION,
      retryable: false,
      detail: `HTTP ${status}`,
    };
  }
  if (status === 400) {
    return {
      category: ToolErrorCategoryEnum.VALIDATION,
      retryable: false,
      detail: `HTTP ${status}`,
    };
  }
  return { category: ToolErrorCategoryEnum.FATAL, retryable: false, detail: `HTTP ${status}` };
}

export async function maybePersistLargeToolOutput(
  toolName: string,
  content: string,
  budget: number,
): Promise<string> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= Math.min(TOOL_OUTPUT_ARTIFACT_THRESHOLD_BYTES, Math.max(0, budget))) {
    return content;
  }

  try {
    const dir = path.join(wstackGlobalRoot(), 'tool-output');
    await fs.mkdir(dir, { recursive: true });
    const safeTool = toolName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'tool';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${stamp}-${safeTool}-${randomUUID()}.log`);
    await fs.writeFile(filePath, content, 'utf8');
    const marker =
      `[full tool output: ${bytes} bytes at ${filePath}; ` +
      'read/grep that file selectively instead of re-running or requesting more output]';
    const fixedBytes = Buffer.byteLength(marker + TOOL_OUTPUT_ARTIFACT_OMISSION, 'utf8');
    const previewBytes = Math.min(
      TOOL_OUTPUT_ARTIFACT_PREVIEW_BYTES,
      Math.max(0, budget - fixedBytes),
    );
    if (previewBytes < 256) return marker;

    const headBudget = Math.ceil(previewBytes / 2);
    const tailBudget = previewBytes - headBudget;
    const head = sliceUtf8Prefix(content, headBudget);
    const tail = sliceUtf8Suffix(content, tailBudget);
    return `${marker}\n${head}${TOOL_OUTPUT_ARTIFACT_OMISSION}${tail}`;
  } catch {
    return content;
  }
}

export function hashPermissionInput(
  input: unknown,
  scrubber: ToolExecutorOptions['secretScrubber'],
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? '';
  } catch {
    serialized = String(input);
  }
  return createHash('sha256').update(scrubber.scrub(serialized), 'utf8').digest('hex');
}

function sliceUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

function sliceUtf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const chars = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(text.length - chars), 'utf8') <= maxBytes) low = chars;
    else high = chars - 1;
  }
  let start = text.length - low;
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start++;
  return text.slice(start);
}

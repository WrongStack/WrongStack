import { createHash } from 'node:crypto';
import type { ToolResultBlock } from '@wrongstack/contracts/types/blocks';

// Keep the full, scrubbed output's digest off provider blocks and journals.
// A random spool path is not new evidence. Content-changing policies invalidate
// this binding rather than exposing a fingerprint for a different result.
const fingerprints = new WeakMap<ToolResultBlock, { content: string; digest: string }>();

export function fingerprintText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function rememberToolResultFingerprint(block: ToolResultBlock, digest: string): void {
  fingerprints.set(block, { content: block.content, digest });
}

export function toolResultFingerprint(block: ToolResultBlock): string {
  const stored = fingerprints.get(block);
  return stored?.content === block.content ? stored.digest : fingerprintText(block.content);
}

export function appendToolResultContext(block: ToolResultBlock, context: string): ToolResultBlock {
  const next = { ...block, content: `${block.content}${context}` };
  rememberToolResultFingerprint(
    next,
    fingerprintText(JSON.stringify([toolResultFingerprint(block), context])),
  );
  return next;
}

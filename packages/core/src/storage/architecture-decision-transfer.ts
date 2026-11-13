import {
  type ArchitectureDecisionContent,
  validateDecisionContent,
} from './architecture-decision.js';

/** Fits the portable command response limit, including pretty-printed content. */
export const MAX_ADR_TRANSFER_CHARACTERS = 60_000;
export const MAX_ADR_TRANSFER_BYTES = 128 * 1024;
const FORMAT = 'wrongstack-adr';
const CONTENT_FIELDS = new Set([
  'title',
  'context',
  'decision',
  'alternatives',
  'consequences',
  'constraints',
  'scope',
  'revisitWhen',
  'checks',
]);

function checkSize(text: string): void {
  if (
    text.length > MAX_ADR_TRANSFER_CHARACTERS ||
    Buffer.byteLength(text, 'utf8') > MAX_ADR_TRANSFER_BYTES
  )
    throw new Error('ADR transfer exceeds 60000 characters or 128 KiB.');
}

/** Portable content carries no approval, project authority or source-project relationships. */
export function formatArchitectureDecisionTransfer(content: ArchitectureDecisionContent): string {
  const proposal = validateDecisionContent(content);
  delete proposal.supersedes;
  const text = JSON.stringify({ format: FORMAT, version: 1, proposal }, null, 2) + '\n';
  checkSize(text);
  return text;
}

/** Parse/validate only. Callers must explicitly save a proposal and review it separately. */
export function parseArchitectureDecisionTransfer(text: string): ArchitectureDecisionContent {
  checkSize(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('ADR transfer must contain valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('ADR transfer must be a versioned proposal object.');
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).some((key) => !['format', 'version', 'proposal'].includes(key)))
    throw new Error('ADR transfer contains unsupported metadata. Approval cannot be imported.');
  if (envelope.format !== FORMAT || envelope.version !== 1)
    throw new Error('ADR transfer format or version is unsupported.');
  const proposal = envelope.proposal;
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal))
    throw new Error('ADR transfer requires proposal content.');
  if (Object.keys(proposal).some((key) => !CONTENT_FIELDS.has(key)))
    throw new Error('ADR transfer proposal contains unsupported fields or project relationships.');
  return validateDecisionContent(proposal as ArchitectureDecisionContent);
}

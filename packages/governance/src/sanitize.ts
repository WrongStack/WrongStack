/**
 * Redact governance credentials (`wsg_`-prefixed tokens) from a message and
 * cap its length. Single source of truth for the whole workspace — imported by
 * the governance runtime-compatibility and credential-lease paths, and
 * re-exported by `@wrongstack/runtime/governance-sanitize` for the CLI's
 * legacy-fallback path. Lives in `@wrongstack/governance` (a dependency-free
 * leaf package) so both governance and runtime can use it without an import
 * cycle (runtime depends on governance, never the reverse).
 */
export function sanitizeGovernanceMessage(message: string): string {
  if (typeof message !== 'string') return '';
  return capWellFormed(
    message.replace(/wsg_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/gu, '[credential]'),
  );
}

const MESSAGE_CAP = 512;

/**
 * Cap at `max` UTF-16 units without leaving half of a surrogate pair. The
 * message travels through governance IPC responses and the CLI's legacy
 * fallback; a lone unit is ill-formed in both.
 */
function capWellFormed(value: string, max = MESSAGE_CAP): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

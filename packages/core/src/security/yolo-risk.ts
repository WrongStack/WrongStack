import type { DestructiveKind } from '@wrongstack/contracts/types/permission';
import { hasContainerVolumeDestroy, hasDatabaseDestroy, hasFindExec } from './yolo-bulk-risk.js';
import { hasCatastrophicDelete, hasRecursiveForceDelete } from './yolo-delete-risk.js';
import {
  CMD_START,
  haltsTheMachine,
  hasRiskyInlinePayload,
  INLINE_PAYLOAD_INTERPRETERS,
  PAYLOAD_FETCHES_NETWORK,
} from './yolo-payload-risk.js';
import { splitShellSegments } from './yolo-shell-scan.js';
import { hasWriteToAgentStateRoot } from './yolo-state-risk.js';
import { hasExternalPublish, hasGitHistoryRewrite } from './yolo-vcs-risk.js';

export { attachesWellKnownCredential } from './yolo-credentials.js';
export { pathLooksInsideProject } from './yolo-delete-risk.js';
export { HALT_LAUNCHER_VALUE_FLAGS } from './yolo-payload-risk.js';
export { COMMAND_STRING_FLAGS } from './yolo-shell-scan.js';

const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\b(?:mkfs(?:\.[a-z0-9]+)?|mke2fs|newfs)\b/i, // make a filesystem — wipes a partition
  /\bformat\s+[A-Za-z]:/i, // format C: — wipes a Windows volume
  /\bdiskpart\b/i, // Windows partition editor
  /\bdd\b[^|]*\bof=(?:\/dev\/|\\\\[.?]\\)/i, // dd writing straight to a raw device
  />\s*\/dev\/(?:sd|hd|nvme|disk|mapper|vd)/i, // redirect into a raw block device
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // classic fork bomb
  // Same damage, other tools — none was known. Read-only forms stay out:
  // plain `wipefs` lists signatures, `sgdisk -p` prints.
  new RegExp(`${CMD_START}wipefs\\b[^;&|\\n]*\\s(?:-[a-z]*a[a-z]*|--all|-o|--offset)\\b`, 'i'),
  new RegExp(
    `${CMD_START}sgdisk\\b[^;&|\\n]*\\s(?:--zap-all|--zap|--clear|-[a-z]*[zo][a-z]*)\\b`,
    'i',
  ),
  new RegExp(`${CMD_START}blkdiscard\\b`, 'i'), // discards every block of the device
  new RegExp(`${CMD_START}shred\\b[^;&|\\n]*\\s\\/dev\\/`, 'i'), // shred on a device, not a file
  // PowerShell's in-box Storage cmdlets: the equivalents of `format X:` / diskpart.
  new RegExp(`${CMD_START}(?:Clear-Disk|Format-Volume|Remove-Partition)\\b`, 'i'),
];

const HIGH_IMPACT_PATTERNS: RegExp[] = [
  /\b(?:curl|wget|fetch|httpie|http|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]{0,300}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|pwsh|powershell|iex|Invoke-Expression)\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\b[\s\S]{0,120}-(?:enc|encodedcommand)\b/i,
  // Process substitution: `bash <(curl -s URL)` is the same download-and-run as
  // `curl URL | sh`, and a documented install idiom rather than obfuscation —
  // but the pipe pattern above needs a literal `|` and the inline-payload
  // interpreters need a `-c`, so it matched neither (probe-verified 2026-09-22).
  /\b(?:sh|bash|zsh|ksh|fish|pwsh|powershell)(?:\.exe)?\b\s*<\(\s*(?:sudo\s+)?(?:curl|wget|fetch|httpie|http)\b/i,
  // The standard PowerShell download cradle puts `iex` FIRST —
  // `iex (New-Object Net.WebClient).DownloadString('…')`, `iex (irm …)` — so
  // the `download | iex` pipe order above never saw it. Same segment only.
  /\b(?:iex|Invoke-Expression)\b[^;&\n]{0,300}\b(?:DownloadString|DownloadFile|Net\.WebClient|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
  // A downloaded script piped into a non-shell interpreter reading it from
  // stdin — Poetry's official installer is `curl … | python3 -`. Only a bare
  // interpreter or a lone `-` counts: `| python3 -m json.tool` or
  // `| node -e …` read data, not code, and stay frictionless.
  /\b(?:curl|wget|fetch|httpie|http|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]{0,300}\|\s*(?:sudo\s+)?(?:python[0-9.]*|node|perl|ruby|php)(?:\.exe)?(?=\s*(?:$|[;&|)]|-(?:\s|$)))/i,
  // `deno run <url>` executes a remote module fetched at run time.
  /\bdeno(?:\.exe)?\s+run\b[^;&|\n]{0,300}\bhttps?:\/\//i,
];

export function getInputString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export type { DestructiveKind };

/**
 * The two kinds that can switch the approval system itself off, and so may
 * never be un-gated from a settings menu.
 *
 * Writing `trust.json` disables prompting permanently; writing `hooks` into
 * `config.json` is boot-time RCE on the next launch; binding
 * `ANTHROPIC_API_KEY` to an attacker-chosen `baseUrl` exfiltrates the key. All
 * three are reachable by prompt injection, and no workflow needs them
 * unattended — so a user "allow" here would only ever be someone being talked
 * into it.
 */
export const LOCKED_DESTRUCTIVE_KINDS: ReadonlySet<DestructiveKind> = new Set([
  'agent-state',
  'credential-bind',
]);

/**
 * Every kind, in the order a settings menu should list them: worst damage
 * first, the two locked ones last. Exhaustiveness is enforced by
 * `UncoveredDestructiveKind` below, so adding a kind to the union without
 * listing it here is a compile error rather than a silently un-gated category.
 */
export const ALL_DESTRUCTIVE_KINDS = [
  'disk-wipe',
  'system-halt',
  'delete-outside',
  'git-history',
  'publish',
  'download-and-run',
  'bulk-delete',
  'agent-state',
  'credential-bind',
] as const satisfies readonly DestructiveKind[];

/**
 * Compile gate for {@link ALL_DESTRUCTIVE_KINDS}. Resolves to `never` while the
 * list is complete; the moment a kind is added to the union without being
 * listed, this becomes that kind and {@link AssertAllKindsListed} fails to
 * compile — naming the offender. Exported so it counts as used.
 */
export type UnlistedDestructiveKind = Exclude<
  DestructiveKind,
  (typeof ALL_DESTRUCTIVE_KINDS)[number]
>;

/**
 * The guard that actually fires. The previous form,
 * `const _assertAllKindsListed: UnlistedDestructiveKind[] = []`, was INERT: an
 * empty array literal is assignable to `X[]` for every `X`, so it compiled with a
 * kind missing. Probe-verified 2026-09-22 by adding an unlisted kind to the union
 * — `packages/core` still typechecked cleanly. That kind would then have been
 * absent from `normalizeYoloConfirmKinds(undefined)`'s default set, i.e. silently
 * UN-GATED under YOLO: the exact failure this gate exists to prevent. A type
 * parameter constrained to `never` rejects anything else outright.
 */
type AssertNever<T extends never> = T;

export type AssertAllKindsListed = AssertNever<UnlistedDestructiveKind>;

/** True when `value` is a kind this build knows — for decoding user config. */
export function isDestructiveKind(value: unknown): value is DestructiveKind {
  return typeof value === 'string' && (ALL_DESTRUCTIVE_KINDS as readonly string[]).includes(value);
}

/**
 * The gated set a policy should actually use: unknown entries dropped, the
 * locked kinds always present.
 *
 * `undefined` means "the user has not chosen" and gates everything — the
 * fail-closed default. An EMPTY set is a real choice (gate only what is
 * locked), which is why it must not be collapsed into `undefined`.
 */
export function normalizeYoloConfirmKinds(
  kinds: Iterable<DestructiveKind> | undefined,
): ReadonlySet<DestructiveKind> {
  if (kinds === undefined) return new Set(ALL_DESTRUCTIVE_KINDS);
  const out = new Set<DestructiveKind>();
  for (const kind of kinds) if (isDestructiveKind(kind)) out.add(kind);
  for (const locked of LOCKED_DESTRUCTIVE_KINDS) out.add(locked);
  return out;
}

/**
 * Decode the user's `autonomy.yoloConfirm` map into the gated set.
 *
 * A key is gated unless the user explicitly wrote `false`, so an unknown or
 * partially-written map only ever un-gates what it names — a truncated file or
 * a kind added by a newer build stays gated rather than silently opening.
 */
export function resolveYoloConfirmKinds(
  preference: Record<string, boolean> | undefined,
): ReadonlySet<DestructiveKind> {
  if (preference === undefined) return new Set(ALL_DESTRUCTIVE_KINDS);
  return normalizeYoloConfirmKinds(
    ALL_DESTRUCTIVE_KINDS.filter((kind) => preference[kind] !== false),
  );
}

/** Set equality, so a no-op update does not flush the permission cache. */
export function sameKindSet(
  a: ReadonlySet<DestructiveKind>,
  b: ReadonlySet<DestructiveKind>,
): boolean {
  if (a.size !== b.size) return false;
  for (const kind of a) if (!b.has(kind)) return false;
  return true;
}

/**
 * Best-effort detection of a *catastrophic* shell command — system-/disk-/
 * home-wide, effectively irreversible destruction, OR a write to WrongStack's
 * own trusted state files that could disable security boundaries.
 *
 * `projectRoot` scopes the delete checks (an in-project cleanup is not an
 * escape); it is deliberately unused for catastrophic and state-root targets,
 * which are resolved absolutely.
 *
 * Returns WHICH kind matched so callers can honour a per-kind user preference.
 * Order matters only for reporting: the most severe kind wins the label.
 */
export function classifyDestructiveCommand(
  command: string,
  projectRoot: string | undefined,
): DestructiveKind | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (CATASTROPHIC_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'disk-wipe';
  if (haltsTheMachine(trimmed)) return 'system-halt';
  if (hasWriteToAgentStateRoot(trimmed)) return 'agent-state';
  if (HIGH_IMPACT_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'download-and-run';
  if (hasCatastrophicDelete(trimmed)) return 'delete-outside';
  if (hasRecursiveForceDelete(trimmed, projectRoot)) return 'delete-outside';
  if (hasGitHistoryRewrite(trimmed)) return 'git-history';
  if (hasExternalPublish(trimmed)) return 'publish';
  if (hasFindExec(trimmed)) return 'bulk-delete';
  if (hasContainerVolumeDestroy(trimmed)) return 'bulk-delete';
  if (hasDatabaseDestroy(trimmed)) return 'bulk-delete';
  if (hasRiskyInlinePayload(trimmed)) {
    // Both halves already matched inside one segment; the network half is the
    // more severe reading, so it wins the label.
    return splitShellSegments(trimmed).some(
      (segment) =>
        INLINE_PAYLOAD_INTERPRETERS.some((pattern) => pattern.test(segment)) &&
        PAYLOAD_FETCHES_NETWORK.test(segment),
    )
      ? 'download-and-run'
      : 'bulk-delete';
  }
  return undefined;
}

/**
 * Boolean form of {@link classifyDestructiveCommand}, kept because most callers
 * only need "is this gated at all".
 */
export function isClearlyDestructiveBashCommand(
  command: string,
  projectRoot: string | undefined,
): boolean {
  return classifyDestructiveCommand(command, projectRoot) !== undefined;
}

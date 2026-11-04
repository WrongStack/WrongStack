import type { DestructiveKind } from '@wrongstack/contracts/types/permission';
import { englishText } from './desktop-text';
import { record } from './engine-values';
import { sameSetting } from './settings-save-model';

export const confirmationKinds = [
  {
    kind: 'disk-wipe',
    label: 'Wipe a disk',
    description: 'Formatting filesystems or writing directly to a raw device.',
  },
  {
    kind: 'system-halt',
    label: 'Shut down or restart',
    description: 'Stopping or restarting the machine.',
  },
  {
    kind: 'delete-outside',
    label: 'Delete outside the project',
    description: 'Recursive force-deletion outside the project or at system/home roots.',
  },
  {
    kind: 'git-history',
    label: 'Rewrite Git history',
    description: 'Discarding repository history, force-pushing or destructive cleanup.',
  },
  {
    kind: 'publish',
    label: 'Publish or deploy',
    description: 'Publishing artifacts, pushing images or changing deployed infrastructure.',
  },
  {
    kind: 'download-and-run',
    label: 'Run downloaded code',
    description: 'Fetching remote content and immediately executing it.',
  },
  {
    kind: 'bulk-delete',
    label: 'Delete in bulk',
    description: 'Deleting collections of files or persistent data.',
  },
  {
    kind: 'agent-state',
    label: 'Write WrongStack trusted state',
    description: 'Changing trusted configuration, hooks, credentials or approval state.',
  },
  {
    kind: 'credential-bind',
    label: 'Bind credentials to an endpoint',
    description: 'Attaching a well-known API credential to a provider URL.',
  },
] as const satisfies readonly { kind: DestructiveKind; label: string; description: string }[];
export const lockedConfirmationKinds: ReadonlySet<string> = new Set([
  'agent-state',
  'credential-bind',
]);
export type ExecutionMode = 'standard' | 'yolo' | 'yolo-plus';
export function executionMode(values: Record<string, unknown>): ExecutionMode {
  return values['yoloPlus'] === true ? 'yolo-plus' : values['yolo'] === true ? 'yolo' : 'standard';
}
export function executionModeValues(mode: ExecutionMode) {
  if (!['standard', 'yolo', 'yolo-plus'].includes(mode))
    throw Error(englishText('settingsMessage', 'execMode'));
  return { yolo: mode !== 'standard', yoloPlus: mode === 'yolo-plus' };
}
export function confirmationMap(value: unknown): Record<string, boolean> {
  const source = record(value);
  const map: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(source))
    if (typeof value === 'boolean') map[key] = value;
  for (const { kind } of confirmationKinds)
    map[kind] = lockedConfirmationKinds.has(kind) || source[kind] !== false;
  return map;
}
/** Treat the two mode flags as one choice, while the shared merge handles independent kind edits. */
export function prepareExecutionPolicyPatch(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...patch };
  const pair = (value: Record<string, unknown>) => [
    value['yolo'] === true,
    value['yoloPlus'] === true,
  ];
  const before = pair(base),
    next = pair(draft),
    live = pair(current);
  if (!sameSetting(before, next)) {
    if (next[1] && !next[0]) throw Error(englishText('settingsMessage', 'execYoloPlus'));
    if (!sameSetting(before, live) && !sameSetting(next, live))
      throw Error(englishText('settingsMessage', 'execChanged'));
    result['yolo'] = next[0];
    result['yoloPlus'] = next[1];
  }
  if (Object.hasOwn(result, 'yoloConfirm'))
    result['yoloConfirm'] = confirmationMap(result['yoloConfirm']);
  return result;
}

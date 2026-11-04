import type { ChipOption } from '../ui/ChipMultiSelect';

// Roles and fallback profiles are fixed WrongStack semantics (not provider data),
// so they stay static. Providers and models are loaded live from the user's saved
// configuration via useProviderModels() in KanbanView.
export const KNOWN_ROLES = [
  'architect',
  'developer',
  'reviewer',
  'tester',
  'verifier',
  'security',
  'documenter',
  'external',
  'leader',
  'shadow',
  'subagent',
] as const;

// Fixed capability vocabulary mirroring core's `ToolCapabilities` — a stable
// security enum (like roles), NOT provider data. Blank = the safe subagent
// default grant (WIDE_SUBAGENT_CAPABILITIES) applied server-side. `label` is the
// English text; `labelKey` shows it in the display language.
export const KNOWN_CAPABILITIES: Array<ChipOption & { labelKey: string }> = [
  {
    value: 'fs.read',
    label: 'Read files',
    labelKey: 'activity:kanbanText.capability.fsRead',
    description: 'fs.read',
  },
  {
    value: 'fs.write',
    label: 'Write files (in project)',
    labelKey: 'activity:kanbanText.capability.fsWrite',
    description: 'fs.write',
  },
  {
    value: 'fs.write.outside-project',
    label: 'Write outside project',
    labelKey: 'activity:kanbanText.capability.fsWriteOutside',
    description: 'fs.write.outside-project',
  },
  {
    value: 'net.outbound',
    label: 'Outbound network',
    labelKey: 'activity:kanbanText.capability.netOutbound',
    description: 'net.outbound',
  },
  {
    value: 'shell.exec',
    label: 'Run project commands',
    labelKey: 'activity:kanbanText.capability.shellExec',
    description: 'shell.exec',
  },
  {
    value: 'shell.restricted',
    label: 'Restricted shell',
    labelKey: 'activity:kanbanText.capability.shellRestricted',
    description: 'shell.restricted',
  },
  {
    value: 'shell.arbitrary',
    label: 'Arbitrary shell',
    labelKey: 'activity:kanbanText.capability.shellArbitrary',
    description: 'shell.arbitrary',
  },
  {
    value: 'session.todo',
    label: 'Session todos',
    labelKey: 'activity:kanbanText.capability.sessionTodo',
    description: 'session.todo',
  },
  {
    value: 'tool.meta',
    label: 'Tool metadata',
    labelKey: 'activity:kanbanText.capability.toolMeta',
    description: 'tool.meta',
  },
  {
    value: 'tool.mutate.any',
    label: 'Invoke any tool',
    labelKey: 'activity:kanbanText.capability.toolMutateAny',
    description: 'tool.mutate.any',
  },
  {
    value: 'memory.read',
    label: 'Read memory',
    labelKey: 'activity:kanbanText.capability.memoryRead',
    description: 'memory.read',
  },
  {
    value: 'memory.write',
    label: 'Write memory',
    labelKey: 'activity:kanbanText.capability.memoryWrite',
    description: 'memory.write',
  },
  {
    value: 'package.install',
    label: 'Install packages',
    labelKey: 'activity:kanbanText.capability.packageInstall',
    description: 'package.install',
  },
  {
    value: 'subagent.spawn',
    label: 'Spawn subagents',
    labelKey: 'activity:kanbanText.capability.subagentSpawn',
    description: 'subagent.spawn',
  },
  {
    value: 'config.mutate',
    label: 'Mutate config / trust',
    labelKey: 'activity:kanbanText.capability.configMutate',
    description: 'config.mutate',
  },
];

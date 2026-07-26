import type { ChipOption } from './ChipMultiSelect';

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
// default grant (WIDE_SUBAGENT_CAPABILITIES) applied server-side.
export const KNOWN_CAPABILITIES: ChipOption[] = [
  { value: 'fs.read', label: 'Read files', description: 'fs.read' },
  { value: 'fs.write', label: 'Write files (in project)', description: 'fs.write' },
  {
    value: 'fs.write.outside-project',
    label: 'Write outside project',
    description: 'fs.write.outside-project',
  },
  { value: 'net.outbound', label: 'Outbound network', description: 'net.outbound' },
  { value: 'shell.exec', label: 'Run project commands', description: 'shell.exec' },
  { value: 'shell.restricted', label: 'Restricted shell', description: 'shell.restricted' },
  { value: 'shell.arbitrary', label: 'Arbitrary shell', description: 'shell.arbitrary' },
  { value: 'session.todo', label: 'Session todos', description: 'session.todo' },
  { value: 'tool.meta', label: 'Tool metadata', description: 'tool.meta' },
  { value: 'tool.mutate.any', label: 'Invoke any tool', description: 'tool.mutate.any' },
  { value: 'memory.read', label: 'Read memory', description: 'memory.read' },
  { value: 'memory.write', label: 'Write memory', description: 'memory.write' },
  { value: 'package.install', label: 'Install packages', description: 'package.install' },
  { value: 'subagent.spawn', label: 'Spawn subagents', description: 'subagent.spawn' },
  { value: 'config.mutate', label: 'Mutate config / trust', description: 'config.mutate' },
];

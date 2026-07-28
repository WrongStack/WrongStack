import type { AgentTimelineEntry } from '@wrongstack/core/coordination';
import type { StatuslineItem as StatuslineItemSource } from './components/statusline-picker.js';

export interface AgentTranscriptReader {
  getTranscript(subagentId: string, limit?: number): AgentTimelineEntry[];
}

export interface AutonomyOption {
  mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  label: string;
  description: string;
  color: string;
}

export interface ProviderOption {
  id: string;
  family: string;
  models: string[];
  modelsLabel?: string | undefined;
}

export type RefineFailureDecision =
  | { kind: 'retry' }
  | { kind: 'fallback' }
  | { kind: 'pick'; providerId: string; model: string }
  | { kind: 'original' }
  | { kind: 'edit' };

export interface RefineFailureModel {
  providerId: string;
  model: string;
  label?: string | undefined;
}

export interface HelpEntry {
  name: string;
  description: string;
  category: string;
  aliases?: string[] | undefined;
  argsHint?: string | undefined;
}

export interface McpPickerItem {
  name: string;
  enabled: boolean;
  status: string;
  transport: string;
  description?: string | undefined;
  toolCount: number;
  lazy?: boolean | undefined;
}

export interface PluginPickerItem {
  name: string;
  enabled: boolean;
  risk: 'low' | 'medium' | 'high';
  summary: string;
  lockable?: boolean | undefined;
}

export interface ToolPickerItem {
  name: string;
  owner: string;
  category: string;
  enabled: boolean;
  mutating: boolean;
  permission: string;
  descMode: 'extend' | 'simple';
  description: string;
}

export interface ShadowState {
  activeId: string | null;
  running: boolean;
  model: string;
  intervalMs: number;
}

export interface ProjectPickerItem {
  key: string;
  label: string;
  subtitle?: string | undefined;
  meta?: string | undefined;
  kind: 'project' | 'action';
}

export interface PromptPickEntry {
  slug: string;
  title: string;
  description: string;
  category: string;
  source: string;
  content: string;
  favorite: boolean;
}

export type SendMode = 'queue' | 'btw' | 'steer';

export type StatuslineItem = StatuslineItemSource;

export interface ChipMeta {
  key: StatuslineItem;
  shownAt: number;
  expiresIn?: number;
}

export interface WorktreeRow {
  branch: string;
  ownerLabel: string;
  status: string;
  insertions: number;
  deletions: number;
  files: number;
  allocatedAt: number;
  conflictFiles?: string[] | undefined;
}

export interface ModeOption {
  id: string;
  name: string;
  description: string;
  family: 'lite' | 'deep' | 'balanced' | 'custom';
  isActive: boolean;
}

export interface LiveAgentEntry {
  id: string;
  name: string;
  status: string;
  currentTool?: string | undefined;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
}

export interface LiveSessionEntry {
  sessionId: string;
  projectName: string;
  projectSlug: string;
  projectRoot?: string | undefined;
  workingDir: string;
  gitBranch?: string | undefined;
  status: string;
  pid: number;
  startedAt: string;
  agentCount: number;
  agents: LiveAgentEntry[];
}

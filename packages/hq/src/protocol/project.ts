import type { HqGovernanceSnapshotPayload } from './governance.js';

export type HqWorkspaceKind = 'git' | 'directory' | 'unknown';

export type HqProjectStatus = 'active' | 'idle' | 'stale' | 'error';

export type HqPathPolicy = 'none' | 'project-relative' | 'redacted' | 'full';

export interface HqProjectIdentity {
  projectId: string;
  projectRoot: string;
  projectName: string;
  gitRemote?: string;
  gitBranch?: string;
  machineId: string;
  workspaceKind: HqWorkspaceKind;
}

export interface HqProjectRecord {
  projectId: string;
  projectName: string;
  projectRootDisplay: string;
  machineIds: readonly string[];
  gitBranch?: string;
  activeClients: number;
  activeSessions: number;
  activeSubagents: number;
  totalCostUsd: number;
  lastActivityAt: string;
  status: HqProjectStatus;
  /** Latest project-owner advisory. It never grants HQ transition authority. */
  governance?: HqGovernanceSnapshotPayload;
}

import type { DesktopProjectEntry, DesktopRuntimeRecord } from '../../shared/types.js';

export type DesktopPanel = 'workspace' | 'projects' | 'quick';
export type ProjectPickerTab = 'recent' | 'registered' | 'all';
export type ProjectPickerVariant = 'dock' | 'full' | 'embedded';

export interface RuntimeProjectGroup {
  key: string;
  name: string;
  root: string;
  kind: DesktopRuntimeRecord['kind'];
  sessions: DesktopRuntimeRecord[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

export function normalizeRuntimeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/g, '').trim().toLowerCase();
}

export function sameProjectRoot(left: string, right: string): boolean {
  return normalizeRuntimeRoot(left) === normalizeRuntimeRoot(right);
}

export function dedupeProjects(projects: DesktopProjectEntry[]): DesktopProjectEntry[] {
  const seen = new Set<string>();
  const next: DesktopProjectEntry[] = [];
  for (const project of projects) {
    const key = normalizeRuntimeRoot(project.root);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(project);
  }
  return next;
}

export function basenameFromPath(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
  if (!normalized) return root;
  return normalized.split('/').filter(Boolean).pop() ?? normalized;
}

export function runtimeProjectKey(runtime: DesktopRuntimeRecord): string {
  if (runtime.kind === 'global-settings') return 'global-settings';
  return `${runtime.kind}:${normalizeRuntimeRoot(runtime.root) || runtime.id}`;
}

export function parseDesktopPanel(value: unknown): DesktopPanel | null {
  return value === 'workspace' || value === 'projects' || value === 'quick' ? value : null;
}

export function parseProjectPickerTab(value: unknown): ProjectPickerTab | null {
  return value === 'recent' || value === 'registered' || value === 'all' ? value : null;
}

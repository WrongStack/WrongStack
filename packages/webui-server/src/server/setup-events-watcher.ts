import * as path from 'node:path';

export interface FileWatcherMetrics {
  fileChangesDetected: number;
  filesProcessed: number;
  broadcastsSent: number;
  debounceResets: number;
  totalDebounceDelayMs: number;
  activeProjects: number;
  averageDebounceDelayMs: number;
  watcherActive: boolean;
}

export function statusProjectHashFromWatchFilename(
  projectsDir: string,
  filename: string | Buffer,
): string | null {
  const raw = String(filename);
  const relative = path.isAbsolute(raw) ? path.relative(projectsDir, raw) : raw;
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2 || parts.at(-1) !== 'status.json') return null;
  return parts.at(-2) ?? null;
}

export function shouldLogWatcherStats(): boolean {
  const value = process.env['WRONGSTACK_WEBUI_WATCHER_STATS']?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function initializeFileWatcherMetrics(metrics: FileWatcherMetrics): void {
  metrics.fileChangesDetected = 0;
  metrics.filesProcessed = 0;
  metrics.broadcastsSent = 0;
  metrics.debounceResets = 0;
  metrics.totalDebounceDelayMs = 0;
  metrics.activeProjects = 0;
  metrics.averageDebounceDelayMs = 0;
  metrics.watcherActive = true;
}

export function averageFileWatcherDebounceDelay(metrics: FileWatcherMetrics | undefined): number {
  if (!metrics || metrics.broadcastsSent === 0) return 0;
  return metrics.totalDebounceDelayMs / metrics.broadcastsSent;
}

export function logFileWatcherMetrics(metrics: FileWatcherMetrics | undefined): void {
  if (!metrics || !shouldLogWatcherStats()) return;
  metrics.averageDebounceDelayMs = averageFileWatcherDebounceDelay(metrics);
  console.log(
    `[setup-events] File watcher stats: ` +
      `${metrics.broadcastsSent} broadcasts, ` +
      `${metrics.fileChangesDetected} file changes, ` +
      `${metrics.debounceResets} debounce resets, ` +
      `avg delay: ${metrics.averageDebounceDelayMs.toFixed(1)}ms, ` +
      `${metrics.activeProjects} active projects`,
  );
}

export function createDefaultFileWatcherMetrics(): FileWatcherMetrics {
  return {
    fileChangesDetected: 0,
    filesProcessed: 0,
    broadcastsSent: 0,
    debounceResets: 0,
    totalDebounceDelayMs: 0,
    activeProjects: 0,
    averageDebounceDelayMs: 0,
    watcherActive: false,
  };
}

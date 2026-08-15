/**
 * Global Process Registry - Cross-Instance Process Tracking
 *
 * Provides functionality to list all WrongStack instances running on the system,
 * track their processes, and display detailed status information.
 */

import * as os from 'node:os';
import {
  getPersistentProcessRegistry,
  type PersistentProcessEntry,
} from './process-registry-persistent.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a WrongStack instance's aggregated information.
 */
export interface InstanceInfo {
  instanceId: string;
  hostname: string;
  mainPid: number;
  startedAt: number;
  lastActivity: number;
  status: 'active' | 'idle' | 'stale';
  processCount: number;
  processes: PersistentProcessEntry[];
  sessionIds: Set<string>;
}

/**
 * Counts of instances by status.
 */
export interface InstanceCounts {
  total: number;
  active: number;
  idle: number;
  stale: number;
  byHostname: Map<string, number>;
}

/**
 * Global process status encompassing all instances.
 */
export interface GlobalProcessStatus {
  localInstance: {
    instanceId: string;
    mainPid: number;
    protectedCount: number;
    platform: string;
    hostname: string;
    uptime: number;
  };
  allInstances: Array<{
    instanceId: string;
    hostname: string;
    mainPid: number;
    processes: PersistentProcessEntry[];
    startedAt: number;
    lastActivity: number;
  }>;
  summary: {
    totalProcesses: number;
    protectedCount: number;
    staleCount: number;
    instanceCount: number;
    activeInstanceCount: number;
  };
  timestamp: number;
}

/**
 * Options for filtering instance listings.
 */
export interface InstanceListOptions {
  /** Include stale instances in the list */
  includeStale?: boolean;
  /** Filter by hostname pattern (supports glob patterns) */
  hostname?: string;
  /** Filter by instance status */
  status?: 'active' | 'idle' | 'stale' | 'all';
}

// ============================================================================
// Constants
// ============================================================================

/** If no heartbeat for this long, instance is considered idle */
const IDLE_THRESHOLD_MS = 2 * 60_000; // 2 minutes

/** If no heartbeat for this long, instance is considered stale */
const STALE_THRESHOLD_MS = 5 * 60_000; // 5 minutes

// ============================================================================
// Utility Functions
// ============================================================================

/** Get current timestamp */
function now(): number {
  return Date.now();
}

/** Format a duration in milliseconds to a human-readable string */
function formatAge(ms: number): string {
  if (ms < 1000) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Format uptime in milliseconds to a compact string */
function formatUptime(ms: number): string {
  return formatAge(ms);
}

/** Simple glob pattern matching for hostname filtering */
function matchGlob(pattern: string, value: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  try {
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(value);
  } catch {
    return false;
  }
}

// ============================================================================
// Instance Listing Functions
// ============================================================================

/**
 * Get list of all known instances (from persistent registry).
 */
export async function listInstances(options: InstanceListOptions = {}): Promise<InstanceInfo[]> {
  const { includeStale = false, hostname, status } = options;
  const timestamp = now();

  const registry = getPersistentProcessRegistry();
  const globalStatus = await registry.getGlobalStatus();

  const instances: InstanceInfo[] = [];
  const instanceMap = globalStatus.instances;

  for (const [instanceId, processes] of instanceMap) {
    if (processes.length === 0) continue;

    // Find the main process (protected: true, spawnMode: 'main')
    const mainProc = processes.find((p) => p.spawnMode === 'main');
    const firstProc = processes.at(0);
    const mainPid = mainProc?.pid ?? firstProc?.pid ?? 0;
    const hostname_ = firstProc?.hostname ?? os.hostname();
    const startedAt = Math.min(...processes.map((p) => p.startedAt));

    // Calculate last activity (most recent heartbeat)
    const lastActivity = Math.max(...processes.map((p) => p.lastHeartbeat));

    // Determine status based on last activity
    const age = timestamp - lastActivity;
    let instanceStatus: 'active' | 'idle' | 'stale' = 'stale';
    if (age < IDLE_THRESHOLD_MS) instanceStatus = 'active';
    else if (age < STALE_THRESHOLD_MS) instanceStatus = 'idle';

    // Collect unique session IDs
    const sessionIds = new Set<string>();
    for (const proc of processes) {
      if (proc.sessionId) {
        sessionIds.add(proc.sessionId);
      }
    }

    // Apply filters
    if (!includeStale && instanceStatus === 'stale') continue;
    if (hostname && !matchGlob(hostname, hostname_)) continue;
    if (status && status !== 'all' && instanceStatus !== status) continue;

    instances.push({
      instanceId,
      hostname: hostname_,
      mainPid,
      startedAt,
      lastActivity,
      status: instanceStatus,
      processCount: processes.length,
      processes,
      sessionIds,
    });
  }

  // Sort by last activity (most recent first)
  instances.sort((a, b) => b.lastActivity - a.lastActivity);

  return instances;
}

/**
 * Get counts of instances by status.
 */
export async function getInstanceCount(): Promise<InstanceCounts> {
  const instances = await listInstances({ includeStale: true });
  const byHostname = new Map<string, number>();

  let active = 0;
  let idle = 0;
  let stale = 0;

  for (const inst of instances) {
    const current = byHostname.get(inst.hostname) ?? 0;
    byHostname.set(inst.hostname, current + 1);

    switch (inst.status) {
      case 'active':
        active++;
        break;
      case 'idle':
        idle++;
        break;
      case 'stale':
        stale++;
        break;
    }
  }

  return {
    total: instances.length,
    active,
    idle,
    stale,
    byHostname,
  };
}

/**
 * Get global process status across all instances.
 */
export async function getGlobalProcessStatus(): Promise<GlobalProcessStatus> {
  const timestamp = now();
  const registry = getPersistentProcessRegistry();
  const globalStatus = await registry.getGlobalStatus();
  const instances = await listInstances({ includeStale: true });

  // Local instance
  const localInstanceId = registry.getInstanceId();
  const localInstance = instances.find((i) => i.instanceId === localInstanceId);

  let localProtectedCount = 0;
  if (localInstance) {
    localProtectedCount = localInstance.processes.filter((p) => p.protected).length;
  }

  let activeInstanceCount = 0;
  for (const inst of instances) {
    if (inst.status === 'active') activeInstanceCount++;
  }

  return {
    localInstance: localInstance
      ? {
          instanceId: localInstance.instanceId,
          mainPid: localInstance.mainPid,
          protectedCount: localProtectedCount,
          platform: process.platform,
          hostname: localInstance.hostname,
          uptime: timestamp - localInstance.startedAt,
        }
      : {
          instanceId: localInstanceId,
          mainPid: process.pid,
          protectedCount: 0,
          platform: process.platform,
          hostname: os.hostname(),
          uptime: 0,
        },
    allInstances: instances.map((inst) => ({
      instanceId: inst.instanceId,
      hostname: inst.hostname,
      mainPid: inst.mainPid,
      processes: inst.processes,
      startedAt: inst.startedAt,
      lastActivity: inst.lastActivity,
    })),
    summary: {
      totalProcesses: globalStatus.totalProcesses,
      protectedCount: globalStatus.protectedCount,
      staleCount: globalStatus.staleCount,
      instanceCount: instances.length,
      activeInstanceCount,
    },
    timestamp,
  };
}

// ============================================================================
// Formatting Functions
// ============================================================================

/**
 * Format the global status as a human-readable string for display.
 */
export async function formatGlobalStatus(): Promise<string> {
  const status = await getGlobalProcessStatus();
  const lines: string[] = [];

  lines.push('=== WrongStack Global Process Status ===');
  lines.push(`Updated: ${new Date(status.timestamp).toISOString()}`);
  lines.push('');

  // Summary
  lines.push('Summary:');
  lines.push(`  Total processes: ${status.summary.totalProcesses}`);
  lines.push(`  Protected: ${status.summary.protectedCount}`);
  lines.push(`  Stale entries: ${status.summary.staleCount}`);
  lines.push(
    `  Instances: ${status.summary.instanceCount} (${status.summary.activeInstanceCount} active)`,
  );
  lines.push('');

  // Local instance
  lines.push(`This instance (${status.localInstance.instanceId}):`);
  lines.push(`  Main PID: ${status.localInstance.mainPid}`);
  lines.push(`  Protected processes: ${status.localInstance.protectedCount}`);
  lines.push(`  Platform: ${status.localInstance.platform} (${status.localInstance.hostname})`);
  lines.push(`  Uptime: ${formatUptime(status.localInstance.uptime)}`);
  lines.push('');

  // Other instances
  for (const instance of status.allInstances) {
    if (instance.instanceId === status.localInstance.instanceId) continue;

    const age = Math.round((status.timestamp - instance.lastActivity) / 1000);
    lines.push(`Instance ${instance.instanceId} (${instance.hostname}):`);

    for (const proc of instance.processes) {
      const procAge = formatAge(status.timestamp - proc.startedAt);
      const heartbeatAge = formatAge(status.timestamp - proc.lastHeartbeat);
      const protected_ = proc.protected ? '[P]' : '   ';

      lines.push(
        `  ${protected_} ${String(proc.pid).padStart(6)}  ${proc.name.padEnd(20)} ` +
          `started ${procAge.padStart(8)}  heartbeat ${heartbeatAge.padStart(6)}  ${proc.spawnMode}`,
      );
    }
    lines.push(`  Last activity: ${age}s ago`);
    lines.push('');
  }

  // Legend
  lines.push('Legend:');
  lines.push('  [P] = Protected (cannot be killed via bash)');
  lines.push('  main = Main WrongStack process');
  lines.push('  spawn = Spawned child process');
  lines.push('  fork = Forked process (e.g., worker threads)');

  return lines.join('\n');
}

/**
 * Format a clean instance list suitable for display.
 */
export async function formatInstanceList(options: InstanceListOptions = {}): Promise<string> {
  const instances = await listInstances(options);
  const count = await getInstanceCount();
  const lines: string[] = [];

  lines.push('=== WrongStack Instances ===');
  lines.push(
    `Total: ${count.total} instances (${count.active} active, ${count.idle} idle, ${count.stale} stale)`,
  );
  lines.push('');

  if (count.byHostname.size > 1) {
    lines.push('By hostname:');
    for (const [host, num] of count.byHostname) {
      lines.push(`  ${host}: ${num} instance${num !== 1 ? 's' : ''}`);
    }
    lines.push('');
  }

  if (instances.length === 0) {
    lines.push('No instances found matching the filter.');
    return lines.join('\n');
  }

  // Table header
  lines.push('INSTANCES:');
  lines.push(
    '  ' +
      [
        'STATUS'.padEnd(7),
        'HOSTNAME'.padEnd(16),
        'MAIN PID'.padEnd(9),
        'PROCS'.padEnd(6),
        'SESSIONS'.padEnd(8),
        'UPTIME'.padEnd(8),
        'LAST ACTIVITY',
      ].join('  '),
  );
  lines.push('  ' + '-'.repeat(80));

  // Table rows
  for (const inst of instances) {
    const uptime = formatAge(Date.now() - inst.startedAt);
    const lastAct = formatAge(Date.now() - inst.lastActivity);
    const statusIcon = inst.status === 'active' ? '[*]' : inst.status === 'idle' ? '[-]' : '[ ]';

    lines.push(
      '  ' +
        [
          `${statusIcon} ${inst.status}`.padEnd(7),
          inst.hostname.padEnd(16),
          String(inst.mainPid).padEnd(9),
          String(inst.processCount).padEnd(6),
          String(inst.sessionIds.size).padEnd(8),
          uptime.padEnd(8),
          `${lastAct} ago`,
        ].join('  '),
    );
  }

  lines.push('');
  lines.push('Use /ps full for detailed process listing per instance.');

  return lines.join('\n');
}

/**
 * Format instance details as a compact summary string.
 */
export async function formatInstanceSummary(): Promise<string> {
  const count = await getInstanceCount();
  const instances = await listInstances({ includeStale: false });

  if (instances.length === 0) {
    return 'No active WrongStack instances.';
  }

  const lines: string[] = [];
  lines.push(`${count.total} instance${count.total !== 1 ? 's' : ''}`);

  // Group by status
  const byStatus = new Map<string, number>();
  for (const inst of instances) {
    byStatus.set(inst.status, (byStatus.get(inst.status) ?? 0) + 1);
  }

  const parts: string[] = [];
  if (byStatus.get('active')) parts.push(`${byStatus.get('active')} active`);
  if (byStatus.get('idle')) parts.push(`${byStatus.get('idle')} idle`);
  if (byStatus.get('stale')) parts.push(`${byStatus.get('stale')} stale`);

  lines.push(`(${parts.join(', ')})`);

  // Total processes
  const totalProcs = instances.reduce((sum, inst) => sum + inst.processCount, 0);
  lines.push(`${totalProcs} total processes`);

  return lines.join(' ');
}

// ============================================================================
// Slash Command
// ============================================================================

/**
 * Create the global /ps slash command.
 */
export function createGlobalPsSlashCommand() {
  return {
    name: 'ps' as const,
    description: 'List all WrongStack instances and their processes',

    async handler(input: string): Promise<{ message: string }> {
      try {
        const trimmed = input.trim();
        const parts = trimmed.split(/\s+/);
        const sub = parts[0]?.toLowerCase() ?? '';

        // /ps list - show instance list
        if (sub === 'list' || sub === 'ls' || sub === '') {
          const output = await formatInstanceList();
          return { message: output };
        }

        // /ps summary - compact one-liner
        if (sub === 'summary' || sub === 'sum') {
          const output = await formatInstanceSummary();
          return { message: output };
        }

        // /ps full - detailed process listing
        if (sub === 'full' || sub === 'detail') {
          const output = await formatGlobalStatus();
          return { message: output };
        }

        // /ps count - just the count
        if (sub === 'count' || sub === 'num') {
          const count = await getInstanceCount();
          return {
            message: `${count.total} instance${count.total !== 1 ? 's' : ''} (${count.active} active, ${count.idle} idle, ${count.stale} stale)`,
          };
        }

        // /ps hostname <pattern> - filter by hostname
        if (sub === 'hostname' || sub === 'host') {
          const pattern = parts.slice(1).join(' ');
          if (!pattern) {
            return { message: 'Usage: /ps hostname <pattern> (e.g., /ps hostname workstation*)' };
          }
          const output = await formatInstanceList({ hostname: pattern });
          return { message: output };
        }

        // /ps status <active|idle|stale|all> - filter by status
        if (sub === 'status' || sub === 'state') {
          const filterStatus = parts[1]?.toLowerCase();
          if (!['active', 'idle', 'stale', 'all'].includes(filterStatus ?? '')) {
            return { message: 'Usage: /ps status <active|idle|stale|all>' };
          }
          const output = await formatInstanceList({
            status: filterStatus as 'active' | 'idle' | 'stale' | 'all',
          });
          return { message: output };
        }

        return {
          message: 'Usage: /ps [list|summary|count|full|hostname <pattern>|status <state>]',
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { message: `Error getting process status: ${message}` };
      }
    },
  };
}

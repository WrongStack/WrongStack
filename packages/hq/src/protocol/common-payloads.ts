/**
 * How the computer a client runs on is doing, sampled with each heartbeat
 * (additive). Numbers only plus the OS family: no paths, users or process
 * names leave the machine.
 */
export interface HqHostHealth {
  /** `process.platform` (win32, linux, darwin, ...). */
  platform: string;
  arch: string;
  cpuCount: number;
  /** One-minute load average. Absent where the OS has none (Windows reports 0). */
  loadAvg1?: number;
  memTotalBytes: number;
  /** Memory the OS can hand out now (Linux `MemAvailable`, else free memory). */
  memAvailableBytes: number;
  osUptimeSec: number;
  /** Space on the volume that holds the project. Absent when it can't be read. */
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  /** Resident memory of the reporting WrongStack process. */
  processRssBytes: number;
}

export interface HqUsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** Provider id that produced this usage (e.g. 'anthropic'), when known. */
  provider?: string;
  /** Model id the cost was priced against, when known. */
  model?: string;
  /** Cache-read (prompt-cache hit) tokens, when reported. */
  cacheRead?: number;
  /** Cache-write tokens, when reported. */
  cacheWrite?: number;
}

/** A physical machine, aggregated by HQ from connected clients' machineId. */
export interface HqMachineRecord {
  machineId: string;
  hostname?: string;
  clientCount: number;
  sessionCount: number;
  agentCount: number;
  projectIds: readonly string[];
  lastActivityAt: string;
  /** The newest host-health sample any client on this machine sent (additive). */
  health?: HqHostHealth & { reportedAt: string };
}

/**
 * A machine HQ has seen before and remembers after its clients disconnect, so
 * an operator can tell "LAB-02 went quiet two hours ago" from "LAB-02 never
 * existed". Keyed by the same hostname-first machine key the snapshot groups
 * live machines by.
 */
export interface HqKnownMachine {
  /** Hostname-first machine key (`host:<lower hostname>` or `mid:<id>`). */
  key: string;
  hostname?: string;
  /** Raw machine ids the processes on this computer reported. */
  machineIds: readonly string[];
  /** Projects that ran here, newest knowledge wins. */
  projects: readonly { projectId: string; projectName: string }[];
  /** The newest WrongStack version a client on this machine reported. */
  lastVersion?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface HqSubagentSummary {
  subagentId: string;
  role?: string;
  status: 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'stopped';
  task?: string;
  currentTool?: string;
  runtimeMs?: number;
  costUsd?: number;
  lastActivityAt?: string;
  /**
   * The provider/model this worker actually runs on, `provider/model` when the
   * provider is known. `FleetTelemetryBridge` has always put it on the wire —
   * the field was missing from this contract, so a consumer could not read it
   * type-safely. It is the answer to "did my per-session model routing take
   * effect", which is otherwise invisible from HQ.
   */
  model?: string;
}

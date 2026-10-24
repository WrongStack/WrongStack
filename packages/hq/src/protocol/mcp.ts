export interface HqMcpLatencySummary {
  count: number;
  lastMs?: number | undefined;
  minMs?: number | undefined;
  maxMs?: number | undefined;
  p50Ms?: number | undefined;
  p95Ms?: number | undefined;
}

export interface HqMcpFailureCounts {
  transport: number;
  protocol: number;
  tool: number;
}

export interface HqMcpHealthCheck {
  name: string;
  passed: boolean;
  value?: number | undefined;
  threshold?: number | undefined;
}

export type HqMcpHealthState =
  | 'disabled'
  | 'dormant'
  | 'connecting'
  | 'healthy'
  | 'degraded'
  | 'failed';

export type HqMcpConnectionState =
  | 'idle'
  | 'dormant'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

export interface HqMcpServerHealth {
  name: string;
  projectId: string;
  clientId: string;
  connectionState: HqMcpConnectionState;
  healthState: HqMcpHealthState;
  lastSuccessAt?: string | undefined;
  lastFailureAt?: string | undefined;
  lastFailureKind?: 'transport' | 'protocol' | 'tool' | undefined;
  consecutiveFailures: number;
  failures: HqMcpFailureCounts;
  reconnectCount: number;
  wakeCount: number;
  sleepCount: number;
  restartCount: number;
  connectionLatency: HqMcpLatencySummary;
  discoveryLatency: HqMcpLatencySummary;
  callLatency: HqMcpLatencySummary;
  inFlightCalls: number;
  peakInFlightCalls: number;
  healthChecks: HqMcpHealthCheck[];
}

export interface HqMcpHealthSnapshotPayload {
  servers: HqMcpServerHealth[];
}

export interface HqMcpOperationPayload {
  operation: Record<string, unknown>;
  servers: HqMcpServerHealth[];
}

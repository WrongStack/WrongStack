export interface ProcessEventMap {
  'process.started': {
    sessionId: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    toolCallId: string;
    toolName: string;
    pid?: number | undefined;
    parentPid: number;
    command: string;
    args: string[];
    cwd: string;
    background: boolean;
    startedAt: string;
  };
  'process.output': {
    sessionId: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    toolCallId: string;
    toolName: string;
    pid?: number | undefined;
    stream: 'stdout' | 'stderr';
    bytes: number;
    chunkHash: string;
    at: string;
  };
  'process.completed': {
    sessionId: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    toolCallId: string;
    toolName: string;
    pid?: number | undefined;
    exitCode: number;
    signal?: string | undefined;
    durationMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    timedOut: boolean;
    endedAt: string;
  };
}

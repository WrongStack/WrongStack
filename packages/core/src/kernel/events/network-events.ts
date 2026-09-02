export interface NetworkEventMap {
  'network.request.started': {
    sessionId: string;
    traceId?: string;
    agentId?: string;
    toolCallId?: string;
    attemptId?: string;
    requestId: string;
    initiator: 'provider' | 'tool';
    operationName: string;
    method: string;
    scheme: string;
    serverAddress: string;
    serverPort?: number;
    pathHash: string;
    queryKeys: string[];
    requestBytes?: number;
    startedAt: string;
  };
  'network.request.completed': {
    sessionId: string;
    traceId?: string;
    agentId?: string;
    toolCallId?: string;
    attemptId?: string;
    requestId: string;
    initiator: 'provider' | 'tool';
    operationName: string;
    method: string;
    scheme: string;
    serverAddress: string;
    serverPort?: number;
    pathHash: string;
    statusCode: number;
    durationMs: number;
    requestBytes?: number;
    responseBytes?: number;
    completedAt: string;
  };
  'network.request.failed': {
    sessionId: string;
    traceId?: string;
    agentId?: string;
    toolCallId?: string;
    attemptId?: string;
    requestId: string;
    initiator: 'provider' | 'tool';
    operationName: string;
    method: string;
    scheme: string;
    serverAddress: string;
    serverPort?: number;
    pathHash: string;
    durationMs: number;
    errorCode?: string;
    errorName: string;
    failedAt: string;
  };
}

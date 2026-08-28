type BridgeMessageType =
  | 'task'
  | 'result'
  | 'progress'
  | 'error'
  | 'heartbeat'
  | 'stop'
  | 'delegate'
  | 'budget_threshold';

export interface BudgetThresholdPayload {
  kind: 'iterations' | 'tool_calls' | 'tokens' | 'cost';
  used: number;
  limit: number;
  /** Subagent's accumulated text so far — useful for partial result */
  partialText: string;
  /** Suggested action: extend limits or accept partial */
  suggestion: 'extend' | 'stop';
  /** Human-readable message */
  message: string;
}

export interface BridgeMessage<T = unknown> {
  id: string;
  type: BridgeMessageType;
  from: string;
  to?: string | undefined;
  payload: T;
  timestamp: number;
  priority?: 'low' | 'normal' | 'high' | 'critical' | undefined;
}

export interface AgentBridgeConfig {
  agentId: string;
  coordinatorId: string;
  timeoutMs?: number | undefined;
  bufferSize?: number | undefined;
}

export interface AgentBridge {
  readonly agentId: string;
  readonly coordinatorId: string;

  send(msg: BridgeMessage): Promise<void>;
  broadcast(msg: BridgeMessage): Promise<void>;
  subscribe(handler: (msg: BridgeMessage) => void | Promise<void>): () => void;
  request<T>(msg: BridgeMessage, timeoutMs?: number): Promise<BridgeMessage<T>> | undefined;
  stop(): Promise<void>;
}

export interface BridgeTransport {
  send(msg: BridgeMessage, to: string): Promise<void>;
  subscribe(agentId: string, handler: (msg: BridgeMessage) => void | Promise<void>): () => void;
  close(agentId: string): Promise<void>;
}

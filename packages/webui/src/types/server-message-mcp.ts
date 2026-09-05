export type WSMcpServerMessage =
  | {
      type: 'config.doctor.result';
      payload: {
        success: boolean;
        applied: boolean;
        changed: boolean;
        changes: Array<{ path: string; action: 'added' | 'replaced' }>;
        configPath: string;
        backupPath?: string;
        error?: string;
      };
    }
  | {
      type: 'mcp.list';
      payload: {
        servers: Array<{
          name: string;
          transport: string;
          status: string;
          enabled: boolean;
          description?: string;
          tools?: string[];
          error?: string;
          pid?: number;
          lazy?: boolean;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
          health?: {
            healthState: 'disabled' | 'dormant' | 'connecting' | 'healthy' | 'degraded' | 'failed';
            consecutiveFailures: number;
            failures: { transport: number; protocol: number; tool: number };
            reconnectCount: number;
            wakeCount: number;
            sleepCount: number;
            restartCount: number;
            inFlightCalls: number;
            peakInFlightCalls: number;
            callLatency: { count: number; lastMs?: number; p50Ms?: number; p95Ms?: number };
          };
        }>;
      };
    }
  | {
      type: 'mcp.server.added';
      payload: {
        server: {
          name: string;
          transport: string;
          status: string;
          enabled: boolean;
          description?: string;
          tools?: string[];
          lazy?: boolean;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
        };
      };
    }
  | { type: 'mcp.server.removed'; payload: { name: string } }
  | {
      type: 'mcp.server.updated';
      payload: {
        server: {
          name: string;
          transport: string;
          status: string;
          enabled: boolean;
          description?: string;
          tools?: string[];
          lazy?: boolean;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
        };
      };
    }
  | { type: 'mcp.server.discovered'; payload: { name: string; tools: string[] } }
  | { type: 'mcp.server.sleeping'; payload: { name: string } }
  | { type: 'mcp.server.waking'; payload: { name: string } }
  | { type: 'mcp.server.connected'; payload: { name: string; pid?: number; toolCount?: number } }
  | { type: 'mcp.server.reconnected'; payload: { name: string; toolCount: number } }
  | { type: 'mcp.server.disconnected'; payload: { name: string; reason: string } }
  | { type: 'mcp.server.error'; payload: { name: string; error: string } }
  | { type: 'mcp.operation_result'; payload: { success: boolean; message: string } }
  | {
      type: 'mcp.resources';
      payload: {
        name: string;
        resources: Array<{
          uri: string;
          name: string;
          description?: string;
          mimeType?: string;
          size?: number;
        }>;
        resourceTemplates: Array<{
          uriTemplate: string;
          name: string;
          description?: string;
          mimeType?: string;
        }>;
      };
    }
  | {
      type: 'mcp.prompts';
      payload: {
        name: string;
        prompts: Array<{
          name: string;
          description?: string;
          arguments?: Array<{ name: string; description?: string; required?: boolean }>;
        }>;
      };
    }
  | {
      type: 'mcp.content.selected';
      payload: {
        kind: 'resource' | 'prompt';
        untrusted: true;
        byteSize: number;
        provenance: {
          origin: 'mcp';
          serverName: string;
          capability: 'resource' | 'prompt';
          resourceUri?: string;
          promptName?: string;
          promptArgumentNames?: string[];
        };
        contents?: unknown[];
        messages?: unknown[];
        description?: string;
      };
    }
  | {
      type: 'mcp.content.error';
      payload: { action: string; name: string; error: string };
    };

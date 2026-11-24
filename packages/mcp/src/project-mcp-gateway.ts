/**
 * Shared loopback HTTP MCP Gateway for concurrent ACP sub-clients.
 *
 * Instead of spawning N * M stdio MCP child processes (each duplicating RAM
 * and startup latency), a WrongStack host can open one loopback HTTP gateway
 * and issue per-worker bearer grants. Each grant binds an isolated actor,
 * sessionId, role, worktreeCwd, and service map (`/mcp/<service>`) backed by
 * `handleHttpRequest` (WS-024 Origin/Host/Content-Type guards + Mcp-Session-Id
 * + per-session in-flight requestId isolation).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MCPServer, MCPServerLogger } from './server-dispatch.js';
import { handleHttpRequest } from './server-http.js';

export interface ProjectMcpGrantSpec {
  actor: string;
  sessionId?: string | undefined;
  role?: string | undefined;
  worktreeCwd?: string | undefined;
  /** Map of `<serviceName>` (e.g. `wrongstack-sage`) -> `MCPServer` instance. */
  services: Readonly<Record<string, MCPServer>>;
}

export interface ProjectMcpHttpDescriptor {
  type: 'http';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface ProjectMcpGrantHandle {
  token: string;
  mcpServers: ProjectMcpHttpDescriptor[];
  revoke(): void;
}

export interface ProjectMcpGatewayOptions {
  host?: string | undefined;
  port?: number | undefined;
  logger?: MCPServerLogger | undefined;
}

interface StoredGrant {
  tokenBuf: Buffer;
  spec: ProjectMcpGrantSpec;
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function tokenEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ProjectMcpGateway {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly httpServer: Server;
  private readonly host: string;
  private readonly logger?: MCPServerLogger | undefined;
  private boundUrl = '';
  private closed = false;

  private constructor(host: string, logger: MCPServerLogger | undefined) {
    this.host = host;
    this.logger = logger;
    this.httpServer = createServer((req, res) => {
      void this.route(req, res);
    });
  }

  static async start(opts: ProjectMcpGatewayOptions = {}): Promise<ProjectMcpGateway> {
    const host = opts.host ?? '127.0.0.1';
    const port = opts.port ?? 0;
    const gw = new ProjectMcpGateway(host, opts.logger);
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => {
        gw.httpServer.off('listening', onListen);
        reject(err);
      };
      const onListen = () => {
        gw.httpServer.off('error', onErr);
        const addr = gw.httpServer.address() as AddressInfo;
        const hostFmt = addr.address.includes(':') ? `[${addr.address}]` : addr.address;
        gw.boundUrl = `http://${hostFmt}:${addr.port}`;
        resolve();
      };
      gw.httpServer.once('error', onErr);
      gw.httpServer.once('listening', onListen);
      gw.httpServer.listen(port, host);
    });
    return gw;
  }

  get url(): string {
    return this.boundUrl;
  }

  get activeGrants(): number {
    return this.grants.size;
  }

  registerGrant(spec: ProjectMcpGrantSpec): ProjectMcpGrantHandle {
    if (this.closed) throw new Error('ProjectMcpGateway is closed');
    const token = randomBytes(24).toString('base64url');
    const grantId = randomBytes(8).toString('hex');
    this.grants.set(grantId, { tokenBuf: Buffer.from(token, 'utf8'), spec });

    const mcpServers: ProjectMcpHttpDescriptor[] = Object.keys(spec.services).map((name) => ({
      type: 'http',
      name,
      url: `${this.boundUrl}/mcp/${encodeURIComponent(name)}`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    }));

    return {
      token,
      mcpServers,
      revoke: () => {
        this.grants.delete(grantId);
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.grants.clear();
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
      this.httpServer.closeAllConnections?.();
    });
  }

  private findGrant(token: string): StoredGrant | undefined {
    const candidate = Buffer.from(token, 'utf8');
    for (const grant of this.grants.values()) {
      if (tokenEquals(grant.tokenBuf, candidate)) return grant;
    }
    return undefined;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?', 1)[0] ?? '/';
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify({ status: 'ok', server: 'wrongstack-project-mcp-gateway' }));
      return;
    }

    const token = extractBearer(req.headers.authorization);
    const grant = token ? this.findGrant(token) : undefined;
    if (!grant) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const prefix = '/mcp/';
    if (!pathname.startsWith(prefix)) {
      res.writeHead(404, {
        'content-type': 'application/json',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const serviceName = decodeURIComponent(pathname.slice(prefix.length));
    const mcpServer = Object.hasOwn(grant.spec.services, serviceName)
      ? grant.spec.services[serviceName]
      : undefined;
    if (!mcpServer) {
      res.writeHead(403, {
        'content-type': 'application/json',
        'x-content-type-options': 'nosniff',
      });
      res.end(
        JSON.stringify({ error: `service "${serviceName}" is not granted for this session` }),
      );
      return;
    }

    // Token already authenticated above; pass `undefined` so handleHttpRequest
    // still runs all WS-024 Origin/Host/Content-Type + Mcp-Session-Id guards.
    await handleHttpRequest(mcpServer, req, res, undefined, this.logger, this.host);
  }
}

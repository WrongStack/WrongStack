import * as http from 'node:http';
import { listenWithRetry } from '@wrongstack/webui-server';

interface ListenLogger {
  warn(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}

export async function startDeferredHttpListen(args: {
  server: http.Server;
  host: string;
  httpPort: number;
  logger: ListenLogger;
  /** Fail-fast bind (no auto-advance on EADDRINUSE). Mirrors WEBUI_STRICT_PORT. */
  strictPort?: boolean;
}): Promise<number> {
  const { server, host, httpPort, logger, strictPort } = args;
  // Bind-time EADDRINUSE safety net: the pre-bind probe (findFreePort)
  // closes its throwaway listener, so a competitor can still land between
  // probe and this bind. Advance past it (bounded) instead of crashing;
  // strict hosts fail fast with a clean rejection.
  const boundPort = await listenWithRetry(server, host, httpPort, {
    maxTries: strictPort ? 1 : 10,
  });
  server.on('error', (err: Error) => {
    logger.error('http_server_error', {
      message: err.message,
      port: boundPort,
    });
  });
  return boundPort;
}

export async function startIpv6LoopbackProxy(args: {
  primary: http.Server;
  httpPort: number;
  logger: ListenLogger;
}): Promise<http.Server | null> {
  const { primary, httpPort, logger } = args;
  const v6 = http.createServer();
  v6.on('request', (req, res) => primary.emit('request', req, res));
  v6.on('upgrade', (req, socket, head) => primary.emit('upgrade', req, socket, head));
  const logIpv6Error = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL' || err.code === 'EADDRINUSE') {
      logger.warn('ipv6_loopback_unavailable', { code: err.code, port: httpPort });
      return;
    }
    logger.error('http_server_error', { message: err.message, port: httpPort });
  };
  v6.on('error', logIpv6Error);
  const ipv6Listening = await new Promise<boolean>((resolveListen) => {
    const onListening = () => {
      v6.off('error', onInitialError);
      resolveListen(true);
    };
    const onInitialError = () => {
      v6.off('listening', onListening);
      resolveListen(false);
    };
    v6.once('listening', onListening);
    v6.once('error', onInitialError);
    v6.listen(httpPort, '::1');
  });
  if (!ipv6Listening) return null;
  console.log(`[WebUI] Also listening on http://[::1]:${httpPort}`);
  return v6;
}

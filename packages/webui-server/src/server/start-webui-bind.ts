import type * as http from 'node:http';
import { formatExternalAccessUrls } from './network-info.js';
import { isStrictPort, listenWithRetry } from './port-utils.js';

export async function bindSharedHttpServer(params: {
  httpServer: http.Server;
  wsHost: string;
  httpPort: number;
  requireToken?: boolean | undefined;
  publicUrl?: string | undefined;
}): Promise<number> {
  const { httpServer, wsHost, requireToken, publicUrl } = params;
  let { httpPort } = params;

  const strictPort = isStrictPort();
  const boundPort = await listenWithRetry(httpServer, wsHost, httpPort, {
    maxTries: strictPort ? 1 : 10,
  });
  if (boundPort !== httpPort) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'webui.port_reassigned',
        protocol: 'HTTP',
        requested: httpPort,
        assigned: boundPort,
        reason: 'bind-time EADDRINUSE retry',
        timestamp: new Date().toISOString(),
      }),
    );
    httpPort = boundPort;
  }
  {
    const authHint = requireToken
      ? ' (authentication required; configure WEBUI_TOKEN out of band)'
      : '';
    console.log(`[WebUI] HTTP server listening on http://${wsHost}:${httpPort}${authHint}`);
    const extraUrls = formatExternalAccessUrls({
      bindHost: wsHost,
      port: httpPort,
      publicUrl,
    });
    if (extraUrls.length > 0) {
      console.log('[WebUI] Protected endpoints on external interfaces:\n' + extraUrls.join('\n'));
    }
  }

  return httpPort;
}

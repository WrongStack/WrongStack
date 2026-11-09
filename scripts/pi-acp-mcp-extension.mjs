/** Explicit Pi extension: register the host's per-session MCP definitions in Pi's native runtime. */
export function registerPiMcpServers(api, servers) {
  for (const server of servers) {
    const config =
      'command' in server
        ? {
            type: 'stdio',
            command: server.command,
            args: server.args ?? [],
            env: Object.fromEntries((server.env ?? []).map((x) => [x.name, x.value])),
          }
        : {
            type: server.type,
            url: server.url,
            headers: Object.fromEntries((server.headers ?? []).map((x) => [x.name, x.value])),
          };
    api.registerMcpServer(server.name, {
      ...config,
      exposure: 'deferred',
      toolExposure: {
        codebase_context: 'direct',
        codebase_search: 'direct',
        codebase_read_symbol: 'direct',
        memory_search: 'direct',
        mailbox_read: 'direct',
        kanban_read: 'direct',
      },
    });
  }
}

export default function (api) {
  registerPiMcpServers(api, JSON.parse(process.env.WRONGSTACK_PI_SESSION_MCP ?? '[]'));
}

import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { id?: number; method?: string };
  if (message.method === 'initialize') {
    const index = process.argv.indexOf('--additional-mcp-config');
    const configFile = index >= 0 ? process.argv[index + 1]?.slice(1) : undefined;
    await writeFile(
      process.env.ACP_LAUNCH_CAPTURE!,
      JSON.stringify({
        configFile,
        config: configFile ? JSON.parse(await readFile(configFile, 'utf8')) : undefined,
        piServers: process.env.WRONGSTACK_PI_SESSION_MCP,
      }),
    );
    send({
      jsonrpc: '2.0',
      id: message.id,
      ...(process.env.ACP_FAIL_INIT === '1'
        ? { error: { code: -32603, message: 'fixture initialization failure' } }
        : { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }),
    });
  } else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
}

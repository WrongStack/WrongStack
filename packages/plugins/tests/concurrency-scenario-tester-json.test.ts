import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import plugin from '../src/concurrency-scenario-tester/index.js';

const servers: http.Server[] = [];

afterEach(async () => {
  for (const srv of servers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe('concurrency_test invariant JSON parsing (F376)', () => {
  it('marks invariant false instead of throwing SyntaxError on non-JSON invariant response', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/invariant') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    let raceTool:
      | {
          execute: (
            input: Record<string, unknown>,
            ctx: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      | undefined;
    await plugin.setup({
      config: { extensions: {} },
      tools: {
        register: (tool: { name: string }) => {
          if (tool.name === 'concurrency_test') raceTool = tool as never;
        },
      },
    } as never);

    const res = (await raceTool!.execute(
      {
        url: `${base}/op`,
        count: 2,
        expectedSuccesses: 2,
        invariant: { url: `${base}/invariant`, expectedJson: { count: 2 } },
      },
      { signal: new AbortController().signal },
    )) as { passed: boolean; invariant: boolean | null };

    expect(res.passed).toBe(false);
    expect(res.invariant).toBe(false);
  });
});

// @ts-check
/**
 * Self-contained smoke test for `@wrongstack/sage-mcp`.
 *
 * Boots the MCP server in-process: a real `SqliteMemoryPort`, a real
 * `MCPServer`, and a real `serveStdio` round-trip over Node `PassThrough`
 * streams. No child-process spawn — meaning it is host-independent
 * (Windows, Linux, macOS) and reliable under CI.
 *
 * Run from the workspace root:
 *
 *   pnpm --filter @wrongstack/sage-mcp tsx scripts/smoke.ts
 *
 * Exits 0 on full pass, non-zero with a clear message on the first
 * failed assertion. No test framework required. Keep this script
 * tiny: it exists so users (and CI) can sanity-check the package
 * outside the vitest harness.
 *
 * Mirrors the 8 assertions proven during Phase 1; reproduced here
 * inside the production `MCPServer` shape so that any divergence
 * between spike and shipped package surfaces as a smoke failure.
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { type MCPServer, serveStdio } from '@wrongstack/mcp';
import { SqliteMemoryPort } from '@wrongstack/sage';
import { createSageMcpServer } from '../src/adapter.js';

class SmokeFailure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message);
}

type RpcResponse = Record<string, unknown>;

/**
 * Send a JSON-RPC request and await exactly one response.
 *
 * Per-call state is captured in the closure (no shared buffer), and
 * the listener is registered BEFORE writing — PassThrough is
 * async-flushed, so a listener attached after the write would miss
 * the data event.
 */
function sendAndRead(
  stdin: NodeJS.WritableStream,
  stdout: NodeJS.ReadableStream,
  message: object,
): Promise<RpcResponse> {
  return new Promise<RpcResponse>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new SmokeFailure('timeout: no JSON-RPC response within 5s')),
      5_000,
    );
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const newline = buf.indexOf('\n');
      if (newline < 0) return;
      const line = buf.slice(0, newline);
      clearTimeout(timer);
      stdout.off('data', onData);
      try {
        resolve(JSON.parse(line) as RpcResponse);
      } catch (error) {
        reject(new SmokeFailure(`malformed JSON-RPC response: ${String(error)}`));
      }
    };
    stdout.on('data', onData);
    stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function textOf(result: Record<string, unknown>): string {
  const blocks = result['content'];
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  const first = blocks[0];
  if (typeof first === 'object' && first !== null && 'text' in first) {
    return String((first as { text: unknown }).text);
  }
  return String(first);
}

async function main(): Promise<void> {
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sage-mcp-smoke-'));
  process.stderr.write(`[smoke] projectRoot=${projectRoot}\n`);

  const port = new SqliteMemoryPort({ projectRoot });
  await port.initialize();
  await port.remember('Sage-MCP smoke marker: hello from real tools', 'project-memory', {
    tags: ['smoke'],
  });

  const server: MCPServer = createSageMcpServer(port, { writable: true });

  // serveStdio with explicit PassThrough streams — no child process,
  // no OS pipe hand-off, no Windows-stdout-end-event quirks. The
  // exact same code path that Claude Desktop / MCP CLI invoke,
  // just in-process.
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = serveStdio(server, { stdin, stdout });

  try {
    // 1. initialize
    const init = await sendAndRead(stdin, stdout, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const initResult = init['result'] as Record<string, unknown>;
    assert(initResult, 'initialize result missing');
    assert(
      initResult['protocolVersion'] === '2024-11-05',
      `protocolVersion expected "2024-11-05", got ${String(initResult['protocolVersion'])}`,
    );
    const serverInfo = initResult['serverInfo'] as { name: string; version: string };
    assert(
      serverInfo.name === 'wrongstack-sage-mcp',
      `serverInfo.name expected "wrongstack-sage-mcp", got "${serverInfo.name}"`,
    );
    process.stderr.write('[smoke] 1/8 initialize OK\n');

    // 2. tools/list — must list all read-only tools under default policy
    const list = await sendAndRead(stdin, stdout, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const listResult = list['result'];
    const tools =
      listResult && typeof listResult === 'object'
        ? (((listResult as Record<string, unknown>)['tools'] as Array<{
            name: string;
            inputSchema: Record<string, unknown>;
          }>) ?? [])
        : [];
    assert(
      tools.length >= 4,
      `expected >=4 tools, got ${tools.length}. raw response: ${JSON.stringify(list, null, 2)}`,
    );
    assert(
      tools.every((t) => t.inputSchema.type === 'object'),
      'every schema must declare type:"object" at root (JSON Schema 2020-12 floor)',
    );
    const toolNames = tools.map((t) => t.name).sort();
    process.stderr.write(
      `[smoke] 2/8 tools/list OK (${tools.length} tools: ${toolNames.join(', ')})\n`,
    );

    // 3. memory_search — finds the seeded marker
    const search = await sendAndRead(stdin, stdout, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'memory_search',
        arguments: { query: 'smoke marker', limit: 5 },
      },
    });
    const searchResult = search['result'] as Record<string, unknown>;
    assert(searchResult['isError'] === false, 'memory_search must not report isError');
    const searchText = textOf(searchResult);
    assert(
      searchText.includes('hello from real tools'),
      `memory_search result missing marker: ${searchText.slice(0, 200)}`,
    );
    process.stderr.write('[smoke] 3/8 memory_search round-trips the seeded memory\n');

    // 4. memory_delete WITHOUT force:true -> isError:true (gate survives MCP)
    const refuse = await sendAndRead(stdin, stdout, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'memory_delete', arguments: { id: 'mem_smoke_no_force' } },
    });
    const refuseResult = refuse['result'] as Record<string, unknown>;
    assert(
      refuseResult['isError'] === true,
      `memory_delete without force must be isError:true, got ${JSON.stringify(refuseResult)}`,
    );
    const refuseText = textOf(refuseResult);
    assert(
      /force/i.test(refuseText),
      `memory_delete refusal must mention "force", got: ${refuseText.slice(0, 200)}`,
    );
    process.stderr.write('[smoke] 4/8 memory_delete without force -> isError:true\n');

    // 5. memory_delete WITH force:true on the seeded memory -> success.
    //    Find the seeded memory's id via the typed service capability
    //    so this smoke stays self-contained.
    const sageService = port as unknown as {
      listSage: (statuses?: string[]) => Promise<Array<{ id: string; text: string }>>;
    };
    const all = await sageService.listSage(['active']);
    const ourMemory = all.find((m) => m.text.includes('hello from real tools'));
    assert(ourMemory, 'seeded memory not found in listSage(["active"])');

    const delResp = await sendAndRead(stdin, stdout, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'memory_delete',
        arguments: { id: ourMemory.id, force: true },
      },
    });
    const delResult = delResp['result'] as Record<string, unknown>;
    assert(
      delResult['isError'] === false,
      `memory_delete with force must succeed, got ${JSON.stringify(delResult)}`,
    );
    process.stderr.write('[smoke] 5/8 memory_delete with force:true -> success\n');

    // 6. malformed JSON envelope -> JSON-RPC error (-32700 or -32600)
    const parseErr = await sendAndRead(stdin, stdout, '{not json' as object);
    const parseErrObj = parseErr['error'] as { code?: number } | undefined;
    assert(
      parseErrObj,
      `malformed input must produce error envelope, got: ${JSON.stringify(parseErr)}`,
    );
    assert(
      parseErrObj.code === -32700 || parseErrObj.code === -32600,
      `expected -32700 or -32600, got ${parseErrObj.code as number}`,
    );
    process.stderr.write(`[smoke] 6/8 malformed envelope -> ${parseErrObj.code}\n`);

    // 7. unknown method -> -32601
    const nf = await sendAndRead(stdin, stdout, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/listish',
      params: {},
    });
    const nfErr = nf['error'] as { code?: number } | undefined;
    assert(nfErr, `unknown method must produce error envelope, got: ${JSON.stringify(nf)}`);
    assert(nfErr.code === -32601, `unknown method must be -32601, got ${nfErr.code as number}`);
    process.stderr.write('[smoke] 7/8 unknown method -> -32601\n');

    // 8. unknown tool name -> isError:true (host refusal)
    const unknown = await sendAndRead(stdin, stdout, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'nope_does_not_exist', arguments: {} },
    });
    const unknownResult = unknown['result'] as Record<string, unknown>;
    assert(unknownResult['isError'] === true, 'unknown tool name must be isError:true');
    process.stderr.write('[smoke] 8/8 unknown tool -> isError:true\n');

    process.stderr.write('[smoke] ALL 8 ASSERTIONS PASSED\n');
  } finally {
    stdin.end();
    handle.close();
    await port.dispose();
    await fsPromises.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    if (error instanceof SmokeFailure) {
      process.stderr.write(`[smoke] FAILED: ${error.message}\n`);
    } else {
      process.stderr.write(
        `[smoke] UNEXPECTED ERROR: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`,
      );
    }
    process.exit(1);
  },
);

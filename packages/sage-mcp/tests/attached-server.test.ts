import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MCPServer } from '@wrongstack/mcp';
import { SqliteMemoryPort } from '@wrongstack/sage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAttachedSageMcp } from '../src/attached-server.js';
import { SAGE_MCP_INSTRUCTIONS } from '../src/usage-guide.js';

async function call(server: MCPServer, message: unknown): Promise<Record<string, unknown>> {
  const raw = await server.handleMessage(JSON.stringify(message));
  return JSON.parse(raw ?? 'null') as Record<string, unknown>;
}

function textOf(result: Record<string, unknown>): string {
  const blocks = result['content'] as Array<{ text?: unknown }>;
  return String(blocks?.[0]?.text ?? '');
}

describe('attached SAGE MCP (external coding agents)', () => {
  let dir: string;
  let port: SqliteMemoryPort & { releaseConnection: ReturnType<typeof vi.fn<() => void>> };

  beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sage-mcp-attached-'));
    const base = new SqliteMemoryPort({ projectRoot: dir });
    await base.initialize();
    port = Object.assign(base, { releaseConnection: vi.fn<() => void>() });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await port.dispose();
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('advertises usage instructions and the read + propose surface', async () => {
    const { server } = createAttachedSageMcp(port, { projectRoot: dir, origin: 'claude-code' });

    const init = (await call(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))[
      'result'
    ] as Record<string, unknown>;
    expect(init['instructions']).toBe(SAGE_MCP_INSTRUCTIONS);

    const list = (await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' }))[
      'result'
    ] as {
      tools: Array<{
        name: string;
        inputSchema: { properties: Record<string, { enum?: string[] }> };
      }>;
    };
    const names = list.tools.map((t) => t.name).sort();
    // Read tools + narrowed candidates; no remember/update/delete/hygiene.
    expect(names).toEqual([
      'memory_candidates',
      'memory_for_file',
      'memory_for_path',
      'memory_gather_batch',
      'memory_graph',
      'memory_search',
      'memory_search_explain',
    ]);
    const candidates = list.tools.find((t) => t.name === 'memory_candidates')!;
    expect(candidates.inputSchema.properties['action']?.enum).toEqual(['list', 'propose']);
  });

  it('surfaces a disposed host as a JSON-RPC error on resources/read (F2736)', async () => {
    const attached = createAttachedSageMcp(port, { projectRoot: dir, origin: 'claude-code' });
    attached.dispose();
    const res = await call(attached.server, {
      jsonrpc: '2.0',
      id: 9,
      method: 'resources/read',
      params: { uri: 'sage://project/brief' },
    });
    // The disposed-host error must not be served as a successful JSON resource.
    expect(res?.result).toBeUndefined();
    expect((res?.error as { message?: string } | undefined)?.message).toContain('disposed');
  });

  it('refuses review actions and stamps the origin on proposals', async () => {
    const { server } = createAttachedSageMcp(port, { projectRoot: dir, origin: 'codex' });

    // The narrowed schema already refuses it at the protocol layer.
    const accept = await call(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_candidates', arguments: { action: 'accept', candidate_id: 'x' } },
    });
    // The narrowed schema still refuses it — SEP-1303 moved the refusal from a
    // JSON-RPC error into the tool result, so the model can see why it was
    // denied. The host is never invoked either way, which is the guarantee that
    // actually matters here.
    expect(accept['error']).toBeUndefined();
    const acceptResult = accept['result'] as { isError?: boolean; content?: { text?: string }[] };
    expect(acceptResult.isError).toBe(true);
    expect((acceptResult.content ?? []).map((block) => block.text ?? '').join('\n')).toContain(
      '["list","propose"]',
    );

    const propose = (
      await call(server, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'memory_candidates',
          arguments: {
            action: 'propose',
            text: 'Build core before cli: cli reads core dist types.',
          },
        },
      })
    )['result'] as Record<string, unknown>;
    expect(propose['isError']).toBe(false);

    const listed = (
      await call(server, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'memory_candidates', arguments: { action: 'list' } },
      })
    )['result'] as Record<string, unknown>;
    expect(textOf(listed)).toContain('Proposed by codex over MCP');
  });

  it('releases the daemon socket once calls go idle', async () => {
    vi.useFakeTimers();
    const { server, dispose } = createAttachedSageMcp(port, {
      projectRoot: dir,
      idleReleaseMs: 1_000,
    });

    await call(server, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'anything' } },
    });
    expect(port.releaseConnection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(port.releaseConnection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(port.releaseConnection).toHaveBeenCalledTimes(1);

    // S17-M9: starting a new call while the idle countdown is armed clears the earlier timer on entry
    port.releaseConnection.mockClear();
    await call(server, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'first' } },
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await call(server, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'second' } },
      });
      // clearTimeout is called once on callTool entry (clearing the pending idle timer)
      // and once inside armRelease() in finally
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    } finally {
      clearTimeoutSpy.mockRestore();
    }

    // S17-M10: dispose() clears any pending idle release timer (armed at the end of call #8)
    port.releaseConnection.mockClear();
    dispose();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(port.releaseConnection).not.toHaveBeenCalled();

    // Disposing while a callTool invocation is still in flight must not re-arm the timer in finally
    const second = createAttachedSageMcp(port, {
      projectRoot: dir,
      idleReleaseMs: 1_000,
    });
    const inFlightCall = second.host.callTool('memory_search', { query: 'inflight' });
    second.dispose();
    await inFlightCall;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(port.releaseConnection).not.toHaveBeenCalled();

    // F683: post-dispose callTool is rejected, undefined optional keys are stripped, blank origin is ignored, and CLI --flag=value works
    const postDispose = await second.host.callTool('memory_search', { query: 'after' });
    expect(postDispose).toEqual({ content: 'SAGE MCP host is disposed', isError: true });

    const { parseArgs } = await import('../src/cli.js');
    const eqParsed = parseArgs([
      '--project-root=/tmp/proj',
      '--storage-dir=/tmp/proj/.sage',
      '--port=8765',
      '--token=-sage-secret-999',
    ]);
    expect(eqParsed.httpPort).toBe(8765);
    expect(eqParsed.httpToken).toBe('-sage-secret-999');
    const bareToken = parseArgs(['--project-root', '/tmp/proj', '--token', '--writable']);
    expect(bareToken.tokenMissing).toBe(true);
    expect(bareToken.writable).toBe(true);
  });

  it('does not overflow 32-bit setTimeout when idleReleaseMs exceeds 2^31-1 ms', async () => {
    const attached = createAttachedSageMcp(port, {
      projectRoot: dir,
      idleReleaseMs: 2_147_483_648,
    });
    await attached.host.callTool('memory_search', { query: 'test' });
    await new Promise((r) => setTimeout(r, 30));
    expect(port.releaseConnection).not.toHaveBeenCalled();
    attached.dispose();
  });
});

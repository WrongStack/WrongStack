/**
 * MCPServerToolHost adapter for SAGE Memory.
 *
 * Maps `createSageTools(port)` from `@wrongstack/sage` into the
 * transport-agnostic `MCPServerToolHost` shape expected by
 * `@wrongstack/mcp`'s `MCPServer` (`packages/mcp/src/server.ts:36-39`).
 *
 * Tool-level safety gates (e.g. `force: true` on `memory_delete` from
 * `packages/sage/src/tools/memory-tools.ts:332-340`) are preserved by passing
 * the Sage tool's `Tool.validate` + `Tool.execute` through unchanged —
 * a Sage `validate` failure surfaces as `isError: true` MCP content,
 * the same end-shape `wstack mcp serve` already returns in
 * `packages/cli/src/mcp-serve.ts:298-318`.
 *
 * The synthetic `Context` mirrors `packages/cli/src/mcp-serve.ts:179-214`
 * (`makeServeContext`). It has no provider, no session, no tokenCounter.
 * SAGE's `remember` tool reads `ctx.meta['agentRole']` /
 * `ctx.meta['mode']` to auto-scope audience
 * (`packages/sage/src/tools/memory-tools.ts:166-178`); we force
 * `arguments.no_auto_audience = true` so MCP callers must opt in explicitly.
 */

import type { JSONSchema, MemoryPort, Tool } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { coerceAgainstSchema, validateAgainstSchema } from '@wrongstack/core/utils';
import {
  MCPServer,
  type MCPServerCallResult,
  type MCPServerTool,
  type MCPServerToolHost,
} from '@wrongstack/mcp';
import {
  createSageTools,
  getSageService,
  isSqliteAvailable,
  type SageServiceLike,
} from '@wrongstack/sage';
import { type SageMcpPolicyOptions, selectAllowedTools } from './policy.js';
import { SERVER_INFO } from './version.js';

export interface SageMcpToolHostOptions extends SageMcpPolicyOptions {
  /**
   * Project root the served memory belongs to, used for the synthetic
   * `Context`. Defaults to `process.cwd()`.
   *
   * The CLI already requires and canonicalizes `--project-root` to build the
   * port, so defaulting the Context to the server's cwd meant the two could
   * disagree: every tool would be told it was operating on whatever directory
   * the MCP server happened to be launched from. No SAGE tool reads
   * `ctx.projectRoot` today — the store resolves anchors against its OWN root
   * (`SqliteCreateCandidateContext`), and the middleware that does read it
   * (`path-remap`, `tool-call-memory`) only runs in the agent loop, never
   * here — so this is a trap rather than a live defect. It is worth closing
   * anyway: a tool that later reads the field would mis-resolve paths
   * silently, and "silently anchored to the wrong root" is not a failure that
   * announces itself.
   */
  projectRoot?: string | undefined;
}

/**
 * Resolve the SAGE service capability from any `MemoryPort`. Both
 * `SqliteMemoryPort` and `ProjectSageMemoryPort` expose it via
 * `getCapability(SAGE_SERVICE_CAPABILITY)`; if either is missing,
 * we throw a precise error.
 *
 * The capability lookup is the same shape
 * `packages/runtime/src/container.ts:131-152` already relies on for
 * wiring the IPC bound port into the tool registry.
 */
export function requireSageService(port: MemoryPort): SageServiceLike {
  const service = getSageService(port);
  if (!service) {
    throw new Error(
      'SAGE MCP: the supplied MemoryPort does not expose the SAGE service capability. ' +
        'Use the port created by createProjectSageMemoryPort(...) or SqliteMemoryPort directly.',
    );
  }
  return service;
}

export function createSageMcpToolHost(
  port: MemoryPort,
  opts: SageMcpToolHostOptions = {},
): MCPServerToolHost {
  if (!isSqliteAvailable()) {
    // The same gate as `packages/runtime/src/container.ts:139-144` —
    // SAGE requires Node >= 22.5 with `node:sqlite`. Fail loudly here
    // instead of letting the first `Tool.execute` crash mid-protocol.
    throw new Error('SAGE MCP: node:sqlite is unavailable; SAGE requires Node >= 22.5');
  }

  const service = requireSageService(port);
  const allTools: Tool[] = createSageTools(service);
  const allowed = selectAllowedTools(allTools, opts);
  const allowedByName = new Map<string, Tool>(allowed.map((entry) => [entry.name, entry.tool]));

  // Synthetic Context — no provider / session / tokenCounter. SAGE-only memory
  // ops never read those fields; `ctx.meta` is empty, which makes
  // `no_auto_audience = true` (set below) both deterministic and defensible.
  const ctx = createSyntheticContext(opts.projectRoot);

  function jsonSchemaToObject(schema: JSONSchema): Record<string, unknown> {
    // JSONSchema's permissive `[k: string]: unknown` already satisfies the
    // MCP `Record<string, unknown>` inputSchema contract. We only narrow
    // the top-level return type for the strict MCPServerTool type.
    return schema as unknown as Record<string, unknown>;
  }

  return {
    listTools(): MCPServerTool[] {
      return allowed.map(
        ({ name, tool }): MCPServerTool => ({
          name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: jsonSchemaToObject(tool.inputSchema),
        }),
      );
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
      callOptions?: { signal?: AbortSignal | undefined },
    ): Promise<MCPServerCallResult> {
      const tool = allowedByName.get(name);
      if (!tool) {
        return {
          content: `Tool "${name}" is not exposed by this SAGE MCP server`,
          isError: true,
        };
      }

      try {
        const signal = callOptions?.signal ?? new AbortController().signal;
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('SAGE call cancelled');
        }

        // For `remember`, force no_auto_audience=true. SAGE's auto-audience
        // detection reads `ctx.meta['agentRole']`/`ctx.meta['mode']`; MCP
        // callers do not supply a role/mode so we cannot infer one.
        let callArgs: Record<string, unknown> = { ...args };
        if (name === 'remember') {
          callArgs['no_auto_audience'] = true;
        }

        // The agent loop holds every call to the tool's inputSchema
        // (core tool-executor-guard: validate, then coerce-and-revalidate);
        // MCPServer validates nothing, and the read tools define no
        // `validate`, so without this an MCP caller skipped the schema's
        // bounds — `memory_search` with `limit: 1e9` returned the whole
        // matching store past the schema's `maximum: 100`.
        const validation = validateAgainstSchema(callArgs, tool.inputSchema);
        if (!validation.ok) {
          const coercion = coerceAgainstSchema(callArgs, tool.inputSchema);
          const revalidation = coercion.changed
            ? validateAgainstSchema(coercion.value, tool.inputSchema)
            : validation;
          if (!(coercion.changed && revalidation.ok)) {
            return {
              content: revalidation.errors
                .map((e) => `${e.path || 'input'}: ${e.message}`)
                .join('\n'),
              isError: true,
            };
          }
          callArgs = coercion.value as Record<string, unknown>;
          if (name === 'remember') {
            callArgs['no_auto_audience'] = true;
          }
        }

        // Tool.validate is the canonical safety gate (e.g., the `force: true`
        // requirement on memory_delete). Surface validation failures exactly
        // like `wstack mcp serve` would.
        const validate = tool.validate;
        if (typeof validate === 'function') {
          const errors = await validate(callArgs);
          if (Array.isArray(errors) && errors.length > 0) {
            return { content: errors.join('\n'), isError: true };
          }
        }

        const output = await tool.execute(callArgs, ctx, { signal });
        signal.throwIfAborted();
        if (typeof output === 'string') return { content: output, isError: false };
        return { content: output as unknown, isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: message, isError: true };
      }
    },
  };
}

function createSyntheticContext(projectRoot?: string): Context {
  // Minimal Context stand-in. SAGE memory ops only read `ctx.meta`; the
  // provider/session/tokenCounter stubs throw on use, which is desired
  // because MCP-side memory calls are pure data operations.
  const root = projectRoot ?? process.cwd();
  return {
    systemPrompt: [],
    cwd: root,
    projectRoot: root,
    allowOutsideProjectRoot: false,
    model: 'sage-mcp',
    tools: [],
    meta: {},
  } as unknown as Context;
}

export function createSageMcpServer(
  port: MemoryPort,
  opts: SageMcpToolHostOptions = {},
): MCPServer {
  const host = createSageMcpToolHost(port, opts);
  return new MCPServer({
    host,
    serverInfo: { name: 'wrongstack-sage-mcp', version: SERVER_INFO.version },
  });
}

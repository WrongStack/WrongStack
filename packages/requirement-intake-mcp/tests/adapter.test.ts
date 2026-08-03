import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AllowAllIntakeAuthorizer,
  RequirementIntakeService,
  RequirementIntakeStore,
  type IntakeContext,
} from '@wrongstack/requirement-intake';
import {
  createRequirementIntakeMcpServer,
  createRequirementIntakeMcpToolHost,
} from '../src/adapter.js';

const REQUEST_TEXT = 'Add email-based password reset so users can recover access.';

describe('createRequirementIntakeMcpToolHost', () => {
  it('advertises only the read tool by default', async () => {
    const host = createRequirementIntakeMcpToolHost('C:/project');
    const tools = await host.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['requirement_intake_list']);
  });

  it('advertises the submit tool when writable', async () => {
    const host = createRequirementIntakeMcpToolHost('C:/project', { writable: true });
    const tools = await host.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'requirement_intake_list',
      'requirement_intake_submit',
    ]);
    const submitSchema = tools[1]!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(submitSchema.properties['request']).toBeDefined();
    expect(submitSchema.required).toContain('request');
  });

  it('refuses tools outside the policy', async () => {
    const host = createRequirementIntakeMcpToolHost('C:/project');
    const result = await host.callTool('requirement_intake_submit', { request: REQUEST_TEXT });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('not exposed');
  });

  it('submits an intake record and preserves the original request verbatim', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-mcp-adapter-'));
    try {
      const store = new RequirementIntakeStore({ baseDir: dir });
      const service = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const host = createRequirementIntakeMcpToolHost('C:/project', {
        writable: true,
        actor: 'cursor-agent',
        dependencies: {
          service,
          resolveProjectId: async () => 'proj_alpha',
        },
      });

      const result = await host.callTool('requirement_intake_submit', {
        request: REQUEST_TEXT,
        requestType: 'feature',
        priority: 'high',
      });
      expect(result.isError).toBe(false);
      const content = result.content as {
        intakeId: string;
        status: string;
        created: boolean;
        projectId: string;
      };
      expect(content.intakeId).toMatch(/^reqi_/);
      expect(content.status).toBe('submitted');
      expect(content.created).toBe(true);
      expect(content.projectId).toBe('proj_alpha');

      const stored = await store.load(content.intakeId);
      expect(stored?.originalRequest).toBe(REQUEST_TEXT);
      expect(stored?.requestedBy).toBe('cursor-agent');
      expect(stored?.requestType).toBe('feature');
      expect(stored?.priority).toBe('high');
      expect(stored?.submittedBy).toBe('cursor-agent');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an error for a blank request', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-mcp-blank-'));
    try {
      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir: dir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const host = createRequirementIntakeMcpToolHost('C:/project', {
        writable: true,
        dependencies: {
          service,
          resolveProjectId: async () => 'proj_alpha',
        },
      });
      const result = await host.callTool('requirement_intake_submit', { request: '   ' });
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain('request');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('maps service validation failures to error content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-mcp-valid-'));
    try {
      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir: dir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const host = createRequirementIntakeMcpToolHost('C:/project', {
        writable: true,
        dependencies: {
          service,
          resolveProjectId: async () => 'proj_alpha',
        },
      });
      const result = await host.callTool('requirement_intake_submit', {
        request: 'x'.repeat(100_001),
      });
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain('validation');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('lists curated intake records, newest first', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-mcp-list-'));
    try {
      const store = new RequirementIntakeStore({ baseDir: dir });
      const service = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const ctx: IntakeContext = {
        id: 'cursor-agent',
        type: 'automation',
        projectId: 'proj_alpha',
      };
      await service.createIntake(
        { projectId: 'proj_alpha', originalRequest: 'first request', requestedBy: 'cursor-agent' },
        ctx,
      );
      await service.createIntake(
        { projectId: 'proj_alpha', originalRequest: 'second request', requestedBy: 'cursor-agent' },
        ctx,
      );

      const host = createRequirementIntakeMcpToolHost('C:/project', {
        actor: 'cursor-agent',
        dependencies: {
          service,
          resolveProjectId: async () => 'proj_alpha',
        },
      });
      const result = await host.callTool('requirement_intake_list', {});
      expect(result.isError).toBe(false);
      const content = result.content as {
        count: number;
        intakes: Array<{ id: string; title: string }>;
      };
      expect(content.count).toBe(2);
      expect(content.intakes[0]?.title).toBe('second request');
      expect(content.intakes.every((entry) => typeof entry.id === 'string')).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('filters listing by status', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-mcp-status-'));
    try {
      const store = new RequirementIntakeStore({ baseDir: dir });
      const service = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const ctx: IntakeContext = {
        id: 'cursor-agent',
        type: 'automation',
        projectId: 'proj_alpha',
      };
      const created = await service.createIntake(
        { projectId: 'proj_alpha', originalRequest: 'draft me', requestedBy: 'cursor-agent' },
        ctx,
      );
      await service.createIntake(
        { projectId: 'proj_alpha', originalRequest: 'submit me', requestedBy: 'cursor-agent' },
        ctx,
      );
      await service.submitIntake(created.record.id, ctx);

      const host = createRequirementIntakeMcpToolHost('C:/project', {
        dependencies: {
          service,
          resolveProjectId: async () => 'proj_alpha',
        },
      });
      const result = await host.callTool('requirement_intake_list', { statuses: ['draft'] });
      const content = result.content as { count: number };
      expect(content.count).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing project identity for listing', async () => {
    const host = createRequirementIntakeMcpToolHost('C:/project', {
      dependencies: {
        resolveProjectId: async () => {
          throw new Error('No WrongStack project identity found — run `wstack init` first');
        },
      },
    });
    const result = await host.callTool('requirement_intake_list', {});
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('project identity');
  });
});

describe('createRequirementIntakeMcpToolHost — default project wiring', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-mcp-root-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates the project identity and files into the project state dir', async () => {
    // Hermetic: WRONGSTACK_HOME is redirected per worker by vitest.setup.ts,
    // so the default store lands in the worker temp dir, not the real home.
    const host = createRequirementIntakeMcpToolHost(root, { writable: true, actor: 'codex-agent' });
    const result = await host.callTool('requirement_intake_submit', { request: REQUEST_TEXT });
    expect(result.isError).toBe(false);
    const content = result.content as { intakeId: string; status: string; projectId: string };
    expect(content.status).toBe('submitted');
    expect(content.projectId).toMatch(/^proj_/);

    const identity = JSON.parse(
      await fs.readFile(path.join(root, '.wrongstack', 'project.json'), 'utf8'),
    ) as { projectId: string };
    expect(identity.projectId).toBe(content.projectId);
  });
});

describe('createRequirementIntakeMcpServer', () => {
  it('serves the intake tools and prompt over JSON-RPC', async () => {
    const server = createRequirementIntakeMcpServer('C:/project', { writable: true });
    const listResponse = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    );
    expect(listResponse).toContain('requirement_intake_list');
    expect(listResponse).toContain('requirement_intake_submit');

    const promptsResponse = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }),
    );
    expect(promptsResponse).toContain('file-requirement-intake');
  });

  it('round-trips a submit through the JSON-RPC server', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-mcp-rpc-'));
    try {
      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir: dir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const server = createRequirementIntakeMcpServer('C:/project', {
        writable: true,
        dependencies: {
          service,
          resolveProjectId: async () => 'proj_alpha',
        },
      });
      const response = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'requirement_intake_submit', arguments: { request: REQUEST_TEXT } },
        }),
      );
      expect(response).toContain('reqi_');
      expect(response).toContain('submitted');
      expect(response).not.toContain('isError":true');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

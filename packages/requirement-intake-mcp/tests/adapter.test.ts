import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AllowAllIntakeAuthorizer,
  type IntakeContext,
  RequirementIntakeService,
  RequirementIntakeStore,
} from '@wrongstack/requirement-intake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('surfaces a failed list query as a JSON-RPC error on resources/read (F2738)', async () => {
    const server = createRequirementIntakeMcpServer('C:/project', {
      dependencies: {
        service: {
          listIntakes: vi.fn().mockRejectedValue(new Error('intake store failed')),
        } as never,
        resolveProjectId: async () => 'proj-1',
      },
    });
    const raw = await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'resources/read',
        params: { uri: 'intake://open' },
      }),
    );
    const res = JSON.parse(raw!) as { error?: { message: string }; result?: unknown };
    // Error prose must not be served as a successful application/json resource.
    expect(res.result).toBeUndefined();
    expect(res.error?.message).toContain('intake store failed');
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

  it('refuses an off-schema status filter instead of answering it (F525)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-mcp-bad-status-'));
    try {
      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir: dir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const host = createRequirementIntakeMcpToolHost('C:/project', {
        dependencies: { service, resolveProjectId: async () => 'proj_alpha' },
      });
      for (const statuses of [['submited'], 'draft', null]) {
        const result = await host.callTool('requirement_intake_list', { statuses });
        expect(result.isError, JSON.stringify(statuses)).toBe(true);
      }
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

  it('does not resolve identity or touch the service for a pre-cancelled call', async () => {
    const resolveProjectId = vi.fn();
    const listIntakes = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const host = createRequirementIntakeMcpToolHost('C:/project', {
      dependencies: {
        service: { listIntakes } as unknown as RequirementIntakeService,
        resolveProjectId,
      },
    });

    await expect(
      host.callTool('requirement_intake_list', {}, { signal: controller.signal }),
    ).resolves.toEqual({ content: 'already cancelled', isError: true });
    expect(resolveProjectId).not.toHaveBeenCalled();
    expect(listIntakes).not.toHaveBeenCalled();
  });

  it('stops after asynchronous identity resolution when cancellation wins', async () => {
    let releaseIdentity!: (projectId: string) => void;
    const identity = new Promise<string>((resolve) => {
      releaseIdentity = resolve;
    });
    const createIntake = vi.fn();
    const controller = new AbortController();
    const host = createRequirementIntakeMcpToolHost('C:/project', {
      writable: true,
      dependencies: {
        service: { createIntake } as unknown as RequirementIntakeService,
        resolveProjectId: vi.fn(() => identity),
      },
    });

    const pending = host.callTool(
      'requirement_intake_submit',
      { request: REQUEST_TEXT },
      { signal: controller.signal },
    );
    controller.abort(new Error('cancelled during identity lookup'));
    releaseIdentity('proj_alpha');

    await expect(pending).resolves.toEqual({
      content: 'cancelled during identity lookup',
      isError: true,
    });
    expect(createIntake).not.toHaveBeenCalled();
  });

  it('does not submit when cancellation wins during asynchronous creation', async () => {
    const record = {
      id: 'reqi_cancelled',
      title: 'Cancelled intake',
      requestType: 'feature',
      status: 'draft',
    };
    let releaseCreate!: (result: {
      record: typeof record;
      created: boolean;
      idempotent: boolean;
    }) => void;
    const creation = new Promise<{
      record: typeof record;
      created: boolean;
      idempotent: boolean;
    }>((resolve) => {
      releaseCreate = resolve;
    });
    const createIntake = vi.fn(() => creation);
    const submitIntake = vi.fn();
    const controller = new AbortController();
    const host = createRequirementIntakeMcpToolHost('C:/project', {
      writable: true,
      dependencies: {
        service: { createIntake, submitIntake } as unknown as RequirementIntakeService,
        resolveProjectId: async () => 'proj_alpha',
      },
    });

    const pending = host.callTool(
      'requirement_intake_submit',
      { request: REQUEST_TEXT },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(createIntake).toHaveBeenCalledTimes(1));
    controller.abort(new Error('cancelled during creation'));
    releaseCreate({ record, created: true, idempotent: false });

    await expect(pending).resolves.toEqual({
      content: 'cancelled during creation',
      isError: true,
    });
    expect(submitIntake).not.toHaveBeenCalled();
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

  it('rejects default listing before project identity exists, forwards title/idempotencyKey, filters invalid statuses, checks post-list abort, and requires strict writable === true', async () => {
    // S16-M10: non-boolean truthy writable does not enable submit tool
    const nonStrictHost = createRequirementIntakeMcpToolHost(root, {
      writable: 'yes' as unknown as boolean,
    });
    expect((await nonStrictHost.listTools()).map((t) => t.name)).toEqual([
      'requirement_intake_list',
    ]);

    // S16-M1: defaultResolveProjectId(root, false) throws when project.json does not exist
    const readHost = createRequirementIntakeMcpToolHost(root);
    const missingIdRes = await readHost.callTool('requirement_intake_list', {});
    expect(missingIdRes.isError).toBe(true);
    expect(String(missingIdRes.content)).toContain('No WrongStack project identity found');

    // S16-M3, S16-M6, S16-M7: explicit title, idempotencyKey, and idempotent: true on second submit
    const writeHost = createRequirementIntakeMcpToolHost(root, {
      writable: true,
      actor: 'codex-agent',
    });
    const first = await writeHost.callTool('requirement_intake_submit', {
      request: REQUEST_TEXT,
      title: 'Explicit custom title',
      idempotencyKey: 'idem-key-1',
    });
    expect(first.isError).toBe(false);
    expect(first.content).toMatchObject({
      title: 'Explicit custom title',
      created: true,
      idempotent: false,
    });

    const second = await writeHost.callTool('requirement_intake_submit', {
      request: REQUEST_TEXT,
      title: 'Explicit custom title',
      idempotencyKey: 'idem-key-1',
    });
    expect(second.isError).toBe(false);
    expect(second.content).toMatchObject({
      title: 'Explicit custom title',
      created: false,
      idempotent: true,
    });

    // S16-M9: filterStatuses strips invalid status strings
    const listed = await writeHost.callTool('requirement_intake_list', {
      statuses: ['submitted', 'not_a_real_status'],
    });
    expect(listed.isError).toBe(false);
    expect((listed.content as { count: number }).count).toBe(1);

    // S16-M8 & S16-M9: post-listIntakes throwIfAborted(signal) + exact filtered statuses passed to service.listIntakes
    const abortCtrl = new AbortController();
    const listIntakesMock = vi.fn(async () => {
      abortCtrl.abort(new Error('aborted-after-list'));
      return [];
    });
    const abortAfterListHost = createRequirementIntakeMcpToolHost(root, {
      dependencies: {
        resolveProjectId: async () => 'proj_alpha',
        service: {
          listIntakes: listIntakesMock,
        } as unknown as RequirementIntakeService,
      },
    });
    await expect(
      abortAfterListHost.callTool(
        'requirement_intake_list',
        { statuses: ['submitted', 'not_a_real_status'] },
        { signal: abortCtrl.signal },
      ),
    ).resolves.toEqual({
      content: 'aborted-after-list',
      isError: true,
    });
    expect(listIntakesMock).toHaveBeenCalledWith('proj_alpha', expect.anything(), {
      statuses: ['submitted'],
    });

    const submitAbortCtrl = new AbortController();
    const abortAfterSubmitHost = createRequirementIntakeMcpToolHost(root, {
      writable: true,
      dependencies: {
        resolveProjectId: async () => 'proj_alpha',
        service: {
          createIntake: vi.fn(async () => ({
            created: true,
            idempotent: false,
            record: {
              id: 'reqi_1',
              title: 'Reset',
              requestType: 'feature',
              status: 'draft',
            },
          })),
          submitIntake: vi.fn(async () => {
            submitAbortCtrl.abort(new Error('aborted-after-submit'));
            return {
              idempotent: false,
              record: {
                id: 'reqi_1',
                title: 'Reset',
                requestType: 'feature',
                status: 'submitted',
              },
            };
          }),
        } as unknown as RequirementIntakeService,
      },
    });
    await expect(
      abortAfterSubmitHost.callTool(
        'requirement_intake_submit',
        { request: REQUEST_TEXT },
        { signal: submitAbortCtrl.signal },
      ),
    ).resolves.toEqual({
      content: 'aborted-after-submit',
      isError: true,
    });
  });

  it('validates create inputs and non-string optionals before resolving project identity', async () => {
    const resolveProjectId = vi.fn(async () => 'proj_alpha');
    const host = createRequirementIntakeMcpToolHost('C:/project', {
      writable: true,
      dependencies: { resolveProjectId },
    });

    await expect(
      host.callTool('requirement_intake_submit', { request: REQUEST_TEXT, priority: 'urgent' }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      host.callTool('requirement_intake_submit', { request: REQUEST_TEXT, priority: 123 }),
    ).resolves.toMatchObject({ isError: true });
    expect(resolveProjectId).not.toHaveBeenCalled();
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

  it('rejects unknown arguments in submit/list and parses --flag=value CLI options cleanly (F682)', async () => {
    const { parseArgs } = await import('../src/main.js');
    const host = createRequirementIntakeMcpToolHost('C:/project', {
      writable: true,
      dependencies: { resolveProjectId: async () => 'proj_alpha' },
    });
    const unknownSubmit = await host.callTool('requirement_intake_submit', {
      request: REQUEST_TEXT,
      idempotency_key: 'typo-key',
    });
    expect(unknownSubmit).toEqual({
      content: 'requirement_intake_submit: unknown argument "idempotency_key"',
      isError: true,
    });

    const unknownList = await host.callTool('requirement_intake_list', {
      status: 'submitted',
    });
    expect(unknownList).toEqual({
      content: 'requirement_intake_list: unknown argument "status"',
      isError: true,
    });

    const eqParsed = parseArgs([
      '--project-root=/tmp/proj',
      '--port=4200',
      '--actor=bot-i',
      '--token=-intake-secret-999',
    ]);
    expect(eqParsed.actor).toBe('bot-i');
    expect(eqParsed.httpPort).toBe(4200);
    expect(eqParsed.httpToken).toBe('-intake-secret-999');

    const bareToken = parseArgs(['--project-root', '/tmp/proj', '--token', '--writable']);
    expect(bareToken.tokenMissing).toBe(true);
    expect(bareToken.writable).toBe(true);

    // F859: requirement_intake_list validates statuses before calling resolveProjectId
    const spyResolve = vi.fn(async () => 'proj_alpha');
    const preflightHost = createRequirementIntakeMcpToolHost('C:/project', {
      dependencies: { resolveProjectId: spyResolve },
    });
    const badStatuses = await preflightHost.callTool('requirement_intake_list', {
      statuses: 'not-an-array',
    });
    expect(badStatuses.isError).toBe(true);
    expect(spyResolve).not.toHaveBeenCalled();
  });
});

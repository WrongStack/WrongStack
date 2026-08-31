import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../src/schema-evolution-guard';

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: { counter: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

function getStatusTool(api: MockApi): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === 'schema_evolution_status',
  );
  if (!call) throw new Error('schema_evolution_status not registered');
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

beforeEach(() => vi.clearAllMocks());

afterEach(async () => {
  const api = makeApi();
  await plugin.teardown?.(api as never);
});

describe('schema-evolution-guard plugin', () => {
  it('registers schema_evolution_status and a PostToolUse write|edit hook', () => {
    const api = makeApi();
    plugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('skips non-matching files', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'README.md', content: 'DROP TABLE users;' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('detects DROP TABLE in SQL migrations', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'prisma/migrations/20240101_init/migration.sql',
        content: 'ALTER TABLE users RENAME TO old_users;\nDROP TABLE old_users;',
      },
      toolResult: { content: '', isError: false },
    });
    expect(result?.additionalContext).toContain('DROP TABLE at line 2');
  });

  it('detects DROP COLUMN and blocks when failSeverity is block', () => {
    const api = makeApi({
      extensions: { 'schema-evolution-guard': { failSeverity: 'block' } },
    });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'edit',
      toolInput: {
        path: 'prisma/migrations/20240102_alter/migration.sql',
        content: 'ALTER TABLE orders DROP COLUMN legacy_note;',
      },
      toolResult: { content: '', isError: false },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('DROP COLUMN at line 1');
  });

  it('detects NOT NULL without default in SQL', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'prisma/migrations/20240103_notnull/migration.sql',
        content: 'ALTER TABLE orders ALTER COLUMN status SET NOT NULL;',
      },
      toolResult: { content: '', isError: false },
    });
    expect(result?.additionalContext).toContain('NOT NULL added without default at line 1');
  });

  it('does not flag NOT NULL when a DEFAULT is present', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'prisma/migrations/20240104_safe/migration.sql',
        content: "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending' NOT NULL;",
      },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('detects required field without default in Prisma schema', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'prisma/schema.prisma',
        content: `model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`,
      },
      toolResult: { content: '', isError: false },
    });
    expect(result?.additionalContext).toContain(
      'required field without default at line 3: email (String)',
    );
  });

  it('does not flag required fields whose only attributes are exempt names', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'prisma/schema.prisma',
        content: `model Audit {
  id        Int      @id
  createdAt DateTime @updatedAt
  author    User     @relation("UserAudit")
  deleted   Boolean  @ignore
}
`,
      },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('flags lookalike attributes like @idempotencyKey as required-without-default', () => {
    // Regression: the exemption used substring containment, so
    // `attrs.includes('@id')` silently waived `@idempotencyKey` fields.
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'prisma/schema.prisma',
        content: `model Ledger {
  externalId String @idempotencyKey
}
`,
      },
      toolResult: { content: '', isError: false },
    });
    expect(result?.additionalContext).toContain(
      'required field without default at line 2: externalId (String)',
    );
  });

  it('detects required fields added to OpenAPI YAML', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'openapi.yaml',
        content: `components:
  schemas:
    User:
      type: object
      required:
        - email
      properties:
        email:
          type: string
`,
      },
      toolResult: { content: '', isError: false },
    });
    expect(result?.additionalContext).toContain(
      'required field added to OpenAPI schema at line 6: email',
    );
  });

  it('detects required fields added to OpenAPI JSON', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'openapi.json',
        content: JSON.stringify({
          components: {
            schemas: {
              User: {
                type: 'object',
                required: ['email', 'phone'],
              },
            },
          },
        }),
      },
      toolResult: { content: '', isError: false },
    });
    const ctx = result?.additionalContext ?? '';
    expect(ctx).toContain('required field added to OpenAPI schema');
    expect(ctx).toContain('email');
    expect(ctx).toContain('phone');
  });

  it('detects required field without default in TypeScript schema files', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'src/user-schema.ts',
        content: `export interface UserSchema {
  id: string;
  email?: string;
}
`,
      },
      toolResult: { content: '', isError: false },
    });
    expect(result?.additionalContext).toContain('required field without default at line 2: id');
  });

  it('honors maxFindings cap', () => {
    const api = makeApi({
      extensions: { 'schema-evolution-guard': { maxFindings: 2 } },
    });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'openapi.json',
        content: JSON.stringify({
          components: {
            schemas: {
              User: { required: ['a', 'b', 'c', 'd'] },
            },
          },
        }),
      },
      toolResult: { content: '', isError: false },
    });
    const ctx = result?.additionalContext ?? '';
    const matches = ctx.match(/required field added to OpenAPI schema at line/g);
    expect(matches?.length).toBe(2);
  });

  it('enabled:false disables the hook', () => {
    const api = makeApi({
      extensions: { 'schema-evolution-guard': { enabled: false } },
    });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: {
        path: 'prisma/migrations/x/migration.sql',
        content: 'DROP TABLE users;',
      },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('status tool reports counters', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    hook({
      toolName: 'write',
      toolInput: {
        path: 'prisma/migrations/x/migration.sql',
        content: 'DROP TABLE users;',
      },
      toolResult: { content: '', isError: false },
    });
    const status = (await getStatusTool(api).execute({})) as {
      counters: Record<string, number>;
      lastFinding: string | null;
    };
    expect(status.counters.scanned).toBe(1);
    expect(status.counters.hits).toBe(1);
    expect(status.counters.warnings).toBe(1);
    expect(status.lastFinding).toContain('DROP TABLE at line 1');
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    plugin.teardown!(api as never);
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters.scanned).toBe(0);
    expect(health.counters.hits).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'schema-evolution-guard: teardown complete',
      expect.any(Object),
    );
  });

  it('is safe to tear down before setup', () => {
    const api = makeApi();
    expect(() => plugin.teardown!(api as never)).not.toThrow();
  });
});

/**
 * Requirements Intake MCP — tool host adapter.
 *
 * Two tools:
 *  - `requirement_intake_list`   (always exposed) — list intake records for
 *    the project, optionally filtered by status.
 *  - `requirement_intake_submit` (writable tier) — file an intake record from
 *    the given request text and submit it immediately. The exact text is
 *    preserved verbatim as the record's immutable `originalRequest`.
 *
 * Records are stored under the project's requirement-intake state dir
 * (`wpaths.projectRequirementIntakes`); the HTTP/stdio MCP transport is the
 * authorization boundary, so the service runs with an allow-all authorizer
 * inside it — mirroring the Kanban MCP and WebUI-server postures.
 */
import {
  ensureProjectIdentity,
  readProjectIdentity,
  resolveWstackPaths,
} from '@wrongstack/core/utils';
import {
  MCPServer,
  type MCPServerCallResult,
  type MCPServerTool,
  type MCPServerToolHost,
} from '@wrongstack/mcp';
import {
  AllowAllIntakeAuthorizer,
  INTAKE_PRIORITIES,
  INTAKE_STATUSES,
  RequirementIntakeService,
  RequirementIntakeStore,
  type IntakeContext,
  type IntakePriority,
  type IntakeStatus,
} from '@wrongstack/requirement-intake';
import {
  selectRequirementIntakeTools,
  type RequirementIntakeMcpPolicyOptions,
  type RequirementIntakeMcpToolName,
} from './policy.js';
import { SERVER_INFO } from './version.js';

export interface RequirementIntakeMcpDependencies {
  /** Pre-built intake service (tests/embeds). Defaults to a fresh per-project service. */
  service?: RequirementIntakeService | undefined;
  /**
   * Resolve the canonical project id. Defaults to reading `.wrongstack/project.json`
   * (`readProjectIdentity`); when missing, `createIfMissing` (submit) creates it.
   */
  resolveProjectId?: ((createIfMissing: boolean) => Promise<string>) | undefined;
}

export interface RequirementIntakeMcpToolHostOptions extends RequirementIntakeMcpPolicyOptions {
  actor?: string | undefined;
  dependencies?: RequirementIntakeMcpDependencies | undefined;
}

const SUBMIT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    request: {
      type: 'string',
      description:
        'The exact software development request to record — a feature, bug fix, refactor, UI/API/infra change, migration, documentation, etc. Preserved verbatim.',
    },
    title: {
      type: 'string',
      description: 'Optional short title. Defaults to a deterministic title from the request.',
    },
    requestType: {
      type: 'string',
      enum: [
        'feature',
        'bug_fix',
        'refactor',
        'performance',
        'security',
        'ui_change',
        'api_change',
        'infrastructure',
        'migration',
        'testing',
        'documentation',
        'maintenance',
        'other',
        'unspecified',
      ],
      description: 'Request type hint. Unknown values normalize to other/unspecified.',
    },
    priority: {
      type: 'string',
      enum: [...INTAKE_PRIORITIES],
      description: 'Desired priority.',
    },
    idempotencyKey: {
      type: 'string',
      description: 'Optional key making create idempotent — retries return the existing record.',
    },
  },
  required: ['request'],
  additionalProperties: false,
};

const LIST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    statuses: {
      type: 'array',
      items: { type: 'string', enum: [...INTAKE_STATUSES] },
      description:
        'Optional status filter (draft, collecting_information, submitted, cancelled, archived).',
    },
  },
  additionalProperties: false,
};

const TOOL_DESCRIPTIONS: Record<RequirementIntakeMcpToolName, string> = {
  requirement_intake_list:
    'List requirement intake records for the project, newest first, optionally filtered by status.',
  requirement_intake_submit:
    'File and submit a requirement intake record from the given request text. Requires server --writable.',
};

function toolDescriptor(name: RequirementIntakeMcpToolName): MCPServerTool {
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: name === 'requirement_intake_submit' ? SUBMIT_SCHEMA : LIST_SCHEMA,
  };
}

function intakeContext(projectId: string, actor: string): IntakeContext {
  return { id: actor, type: 'automation', projectId };
}

async function defaultResolveProjectId(
  projectRoot: string,
  createIfMissing: boolean,
): Promise<string> {
  const existing = await readProjectIdentity(projectRoot);
  if (existing) return existing.projectId;
  if (!createIfMissing) {
    throw new Error(
      'No WrongStack project identity found — run `wstack init` (or file an intake first) to create it',
    );
  }
  return (await ensureProjectIdentity(projectRoot)).identity.projectId;
}

export function createRequirementIntakeMcpToolHost(
  projectRoot: string,
  opts: RequirementIntakeMcpToolHostOptions = {},
): MCPServerToolHost {
  const policy = selectRequirementIntakeTools(opts);
  const allowed = new Set(policy.map((entry) => entry.name));
  const actor = opts.actor?.trim() || 'external-intake-mcp';
  const service =
    opts.dependencies?.service ??
    new RequirementIntakeService({
      store: new RequirementIntakeStore({
        baseDir: resolveWstackPaths({ projectRoot }).projectRequirementIntakes,
      }),
      authorizer: new AllowAllIntakeAuthorizer(),
    });
  const resolveProjectId =
    opts.dependencies?.resolveProjectId ??
    ((createIfMissing: boolean) => defaultResolveProjectId(projectRoot, createIfMissing));

  return {
    listTools(): MCPServerTool[] {
      return policy.map((entry) => toolDescriptor(entry.name));
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<MCPServerCallResult> {
      if (!allowed.has(name as RequirementIntakeMcpToolName)) {
        return {
          content: `Tool "${name}" is not exposed by this Requirements Intake MCP server`,
          isError: true,
        };
      }
      try {
        if (name === 'requirement_intake_submit') {
          return await submitIntake(args);
        }
        return await listIntakes(args);
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };

  async function submitIntake(args: Record<string, unknown>): Promise<MCPServerCallResult> {
    const request = args['request'];
    if (typeof request !== 'string' || request.trim().length === 0) {
      return {
        content: 'requirement_intake_submit requires a non-blank "request" string',
        isError: true,
      };
    }
    const projectId = await resolveProjectId(true);
    const ctx = intakeContext(projectId, actor);
    const result = await service.createIntake(
      {
        projectId,
        originalRequest: request,
        requestedBy: actor,
        ...(typeof args['title'] === 'string' ? { title: args['title'] as string } : {}),
        ...(typeof args['requestType'] === 'string'
          ? { requestType: args['requestType'] as string }
          : {}),
        ...(typeof args['priority'] === 'string'
          ? { priority: args['priority'] as IntakePriority }
          : {}),
        ...(typeof args['idempotencyKey'] === 'string'
          ? { idempotencyKey: args['idempotencyKey'] as string }
          : {}),
      },
      ctx,
    );
    const submitted = await service.submitIntake(result.record.id, ctx);
    return {
      content: {
        intakeId: submitted.record.id,
        title: submitted.record.title,
        requestType: submitted.record.requestType,
        status: submitted.record.status,
        projectId,
        created: result.created,
        idempotent: submitted.idempotent,
      },
      isError: false,
    };
  }

  async function listIntakes(args: Record<string, unknown>): Promise<MCPServerCallResult> {
    const projectId = await resolveProjectId(false);
    const ctx = intakeContext(projectId, actor);
    const statuses = filterStatuses(args['statuses']);
    const records = await service.listIntakes(projectId, ctx, statuses ? { statuses } : undefined);
    return {
      content: {
        projectId,
        count: records.length,
        intakes: records.map((record) => ({
          id: record.id,
          title: record.title,
          requestType: record.requestType,
          status: record.status,
          priority: record.priority,
          updatedAt: record.updatedAt,
          createdAt: record.createdAt,
        })),
      },
      isError: false,
    };
  }
}

function filterStatuses(value: unknown): IntakeStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const known = value.filter((item): item is IntakeStatus =>
    (INTAKE_STATUSES as readonly string[]).includes(String(item)),
  );
  return known.length > 0 ? known : undefined;
}

export function createRequirementIntakeMcpServer(
  projectRoot: string,
  opts: RequirementIntakeMcpToolHostOptions = {},
): MCPServer {
  return new MCPServer({
    host: createRequirementIntakeMcpToolHost(projectRoot, opts),
    serverInfo: { name: 'wrongstack-requirement-intake-mcp', version: SERVER_INFO.version },
    prompts: [
      {
        name: 'file-requirement-intake',
        title: 'File a WrongStack requirement intake',
        description:
          'Record and submit an unstructured software development request as a structured intake record.',
        arguments: [{ name: 'request', description: 'The exact request text', required: true }],
        template:
          'Use requirement_intake_submit to record and submit the request {{request}} verbatim. ' +
          'If a matching intake record may already exist, list records first and reuse the idempotency key pattern.',
      },
    ],
  });
}

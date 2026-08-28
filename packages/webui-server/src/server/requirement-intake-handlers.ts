/**
 * HTTP handlers for the Requirements Intake REST API.
 *
 * Routes (registered in http-server.ts):
 *   POST   /api/projects/:projectId/requirement-intakes
 *   GET    /api/projects/:projectId/requirement-intakes
 *   GET    /api/requirement-intakes/:intakeId
 *   PATCH  /api/requirement-intakes/:intakeId
 *   POST   /api/requirement-intakes/:intakeId/answers
 *   POST   /api/requirement-intakes/:intakeId/suggestions
 *   POST   /api/requirement-intakes/:intakeId/submit
 *   POST   /api/requirement-intakes/:intakeId/cancel
 *   POST   /api/requirement-intakes/:intakeId/archive
 *
 * The HTTP token gate (see http-server.ts) is the authorization boundary;
 * the service runs with a permissive authorizer inside that boundary. Every
 * handler maps `IntakeError` codes to conventional HTTP statuses and never
 * echoes request content into logs.
 */
import type * as http from 'node:http';
import { readProjectIdentity } from '@wrongstack/core/utils';
import {
  IntakeError,
  IntakeValidationError,
  type IntakeContext,
  type RequirementIntakeRecord,
  type RequirementIntakeService,
} from '@wrongstack/requirement-intake';

/** Server-side actor for token-authenticated HTTP callers. */
const SERVER_ACTOR = { id: 'webui-server', type: 'agent' } as const;

/** Max request body accepted by intake endpoints (create requests can be large). */
const MAX_INTAKE_BODY_BYTES = 512_000;

function intakeContext(projectId: string): IntakeContext {
  return { ...SERVER_ACTOR, projectId };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendNotFound(res: http.ServerResponse, intakeId: string): void {
  sendJson(res, 404, {
    error: {
      code: 'INTAKE_NOT_FOUND',
      message: `Requirement intake record not found: ${intakeId}`,
    },
  });
}

/** Map a domain error to an HTTP status + JSON error body. */
function sendIntakeError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof IntakeValidationError) {
    sendJson(res, 400, {
      error: { code: error.code, message: error.message, issues: error.issues },
    });
    return;
  }
  if (error instanceof IntakeError) {
    const status =
      error.code === 'INTAKE_UNAUTHORIZED'
        ? 403
        : error.code === 'INTAKE_NOT_FOUND'
          ? 404
          : error.code === 'INTAKE_SUGGESTION_ERROR'
            ? 502
            : 409; // invalid transition / status locked / conflict
    sendJson(res, status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}

function serviceOr503(
  res: http.ServerResponse,
  service: RequirementIntakeService | undefined,
): service is RequirementIntakeService {
  if (service) return true;
  sendJson(res, 503, {
    error: { code: 'INTAKE_UNAVAILABLE', message: 'Requirement intake service not configured' },
  });
  return false;
}

/** Read a JSON request body (content-type checked, size capped). */
async function readJsonBody(
  res: http.ServerResponse,
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendJson(res, 400, {
      error: {
        code: 'INVALID_CONTENT_TYPE',
        message: `Unsupported Content-Type: ${contentType || '(absent)'}`,
      },
    });
    return null;
  }
  return new Promise((resolve) => {
    let data = '';
    let failed = false;
    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      sendJson(res, 400, { error: { code: 'INVALID_BODY', message } });
      resolve(null);
    };
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      data += chunk.toString('utf8');
      if (data.length > MAX_INTAKE_BODY_BYTES) {
        req.destroy();
        fail('Request body too large');
      }
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(data.trim().length === 0 ? {} : (JSON.parse(data) as Record<string, unknown>));
      } catch {
        fail('Request body is not valid JSON');
      }
    });
    req.on('error', () => fail('Failed to read request body'));
  });
}

/**
 * Load the target record so the handler can derive its project and build a
 * proper operation context. Sends a 404 and returns null when missing.
 */
async function discoverIntake(
  res: http.ServerResponse,
  service: RequirementIntakeService,
  intakeId: string,
): Promise<RequirementIntakeRecord | null> {
  // Discovery reads run in the token-gated server context; the real operation
  // below re-authorizes with the record's own project id.
  const record = await service.getIntake(intakeId, intakeContext(''));
  if (!record) {
    sendNotFound(res, intakeId);
    return null;
  }
  return record;
}

/**
 * List intake records for the server's own project. The webui-server serves
 * one project; the canonical `proj_<ulid>` id lives in `.wrongstack/project.json`,
 * which the frontend cannot read — so this route resolves it server-side and
 * returns it alongside the records (the frontend uses it for the project-scoped
 * create endpoint).
 */
export async function handleRequirementIntakeListForServer(
  res: http.ServerResponse,
  service: RequirementIntakeService | undefined,
  projectRoot: string | undefined,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  if (!projectRoot) {
    sendJson(res, 503, {
      error: { code: 'PROJECT_ROOT_NOT_CONFIGURED', message: 'Project root not configured' },
    });
    return;
  }
  try {
    const identity = await readProjectIdentity(projectRoot);
    if (!identity) {
      sendJson(res, 404, {
        error: {
          code: 'PROJECT_IDENTITY_NOT_FOUND',
          message: 'No project identity found — run `wstack init` first',
        },
      });
      return;
    }
    const projectId = identity.projectId;
    const records = await service.listIntakes(projectId, intakeContext(projectId));
    sendJson(res, 200, { projectId, intakes: records });
  } catch (error) {
    sendIntakeError(res, error);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleRequirementIntakeCreate(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  service: RequirementIntakeService | undefined,
  projectId: string,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  const body = await readJsonBody(res, req);
  if (body === null) return;
  try {
    const result = await service.createIntake(body as never, intakeContext(projectId));
    sendJson(res, result.idempotent ? 200 : 201, result);
  } catch (error) {
    sendIntakeError(res, error);
  }
}

export async function handleRequirementIntakeList(
  res: http.ServerResponse,
  service: RequirementIntakeService | undefined,
  projectId: string,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  try {
    const records = await service.listIntakes(projectId, intakeContext(projectId));
    sendJson(res, 200, records);
  } catch (error) {
    sendIntakeError(res, error);
  }
}

export async function handleRequirementIntakeGet(
  res: http.ServerResponse,
  service: RequirementIntakeService | undefined,
  intakeId: string,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  try {
    const record = await discoverIntake(res, service, intakeId);
    if (!record) return;
    sendJson(res, 200, record);
  } catch (error) {
    sendIntakeError(res, error);
  }
}

export async function handleRequirementIntakeUpdate(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  service: RequirementIntakeService | undefined,
  intakeId: string,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  const body = await readJsonBody(res, req);
  if (body === null) return;
  try {
    const record = await discoverIntake(res, service, intakeId);
    if (!record) return;
    const expectedVersion =
      typeof body['expectedVersion'] === 'number' ? (body['expectedVersion'] as number) : undefined;
    const { expectedVersion: _ignored, ...patch } = body;
    void _ignored;
    const updated = await service.updateIntake(
      intakeId,
      patch as never,
      intakeContext(record.projectId),
      expectedVersion,
    );
    sendJson(res, 200, updated);
  } catch (error) {
    sendIntakeError(res, error);
  }
}

export async function handleRequirementIntakeAnswers(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  service: RequirementIntakeService | undefined,
  intakeId: string,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  const body = await readJsonBody(res, req);
  if (body === null) return;
  try {
    const record = await discoverIntake(res, service, intakeId);
    if (!record) return;
    const updated = await service.addAnswer(
      intakeId,
      body as never,
      intakeContext(record.projectId),
    );
    sendJson(res, 200, updated);
  } catch (error) {
    sendIntakeError(res, error);
  }
}

export async function handleRequirementIntakeSuggestions(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  service: RequirementIntakeService | undefined,
  intakeId: string,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  const body = await readJsonBody(res, req);
  if (body === null) return;
  try {
    const record = await discoverIntake(res, service, intakeId);
    if (!record) return;
    const focus = Array.isArray(body['focus']) ? (body['focus'] as string[]) : undefined;
    const suggestions = await service.generateSuggestions(
      intakeId,
      intakeContext(record.projectId),
      focus,
    );
    sendJson(res, 200, { suggestions });
  } catch (error) {
    sendIntakeError(res, error);
  }
}

export async function handleRequirementIntakeSubmit(
  res: http.ServerResponse,
  service: RequirementIntakeService | undefined,
  intakeId: string,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  try {
    const record = await discoverIntake(res, service, intakeId);
    if (!record) return;
    const result = await service.submitIntake(intakeId, intakeContext(record.projectId));
    sendJson(res, 200, result);
  } catch (error) {
    sendIntakeError(res, error);
  }
}

export async function handleRequirementIntakeCancel(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  service: RequirementIntakeService | undefined,
  intakeId: string,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  const body = await readJsonBody(res, req);
  if (body === null) return;
  try {
    const record = await discoverIntake(res, service, intakeId);
    if (!record) return;
    const reason = typeof body['reason'] === 'string' ? (body['reason'] as string) : undefined;
    const updated = await service.cancelIntake(intakeId, intakeContext(record.projectId), reason);
    sendJson(res, 200, updated);
  } catch (error) {
    sendIntakeError(res, error);
  }
}

export async function handleRequirementIntakeArchive(
  res: http.ServerResponse,
  service: RequirementIntakeService | undefined,
  intakeId: string,
): Promise<void> {
  if (!serviceOr503(res, service)) return;
  try {
    const record = await discoverIntake(res, service, intakeId);
    if (!record) return;
    const updated = await service.archiveIntake(intakeId, intakeContext(record.projectId));
    sendJson(res, 200, updated);
  } catch (error) {
    sendIntakeError(res, error);
  }
}

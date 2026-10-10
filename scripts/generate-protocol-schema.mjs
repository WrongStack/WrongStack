#!/usr/bin/env bun
/**
 * Generate the machine-readable contract of the public API from the
 * TypeScript types in packages/webui-protocol:
 *
 *   schema/ws-core.schema.json  JSON Schema of the conversation core of the
 *                               WebSocket protocol (conversation-core.ts) and
 *                               the error model (error-model.ts)
 *   schema/openapi.json         OpenAPI 3.1 of the HTTP session API (http-api.ts)
 *
 *   bun scripts/generate-protocol-schema.mjs           write both files
 *   bun scripts/generate-protocol-schema.mjs --check   exit 1 when they are stale
 *
 * The types are the source; these files are generated and committed so that
 * non-TypeScript clients can read them from the published package.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'packages/webui-protocol');
const schemaDir = path.join(pkgDir, 'schema');
const require = createRequire(path.join(pkgDir, 'package.json'));
const tsj = require('ts-json-schema-generator');
// The generator bundles its own TypeScript; its AST kinds must come from that copy.
const ts = createRequire(require.resolve('ts-json-schema-generator'))('typescript');

const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

/**
 * Core's declaration files spell some property types as `import('…').X`, a
 * node the generator does not parse. None of them sit on the wire surface
 * itself — they are reached only while resolving an indexed access such as
 * `SessionEvent['type']` — so they are read as `unknown`.
 */
class ImportTypeParser {
  supportsNode(node) {
    return node.kind === ts.SyntaxKind.ImportType;
  }
  createType() {
    return new tsj.UnknownType();
  }
}

function definitionsFor(file, types) {
  const config = {
    ...tsj.DEFAULT_CONFIG,
    path: path.join(pkgDir, 'src', file),
    tsconfig: path.join(pkgDir, 'tsconfig.json'),
    type: '*',
    expose: 'export',
    topRef: true,
    jsDoc: 'extended',
    skipTypeCheck: true,
    additionalProperties: true,
  };
  const program = tsj.createProgram(config);
  const parser = tsj.createParser(program, config, (chain) =>
    chain.addNodeParser(new ImportTypeParser()),
  );
  const generator = new tsj.SchemaGenerator(program, parser, tsj.createFormatter(config), config);
  const definitions = {};
  for (const type of types) {
    const schema = generator.createSchema(type);
    Object.assign(definitions, schema.definitions ?? {});
  }
  return sortKeys(definitions);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

function wsSchema() {
  const definitions = {
    ...definitionsFor('conversation-core.ts', ['CoreClientMessage', 'CoreServerMessage']),
    ...definitionsFor('error-model.ts', ['WrongStackErrorModel']),
  };
  // `SessionMarker.source` is `SessionEvent['type']`: core's journal event
  // vocabulary, which grows with core and is not part of this contract. The
  // generator cannot narrow an indexed access over that union, so it is
  // published as what a client may rely on — a string.
  definitions.SessionMarker.properties.source = {
    type: 'string',
    description: 'The journal event type this marker was projected from.',
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://wrongstack.dev/schema/ws-core.schema.json',
    title: 'WrongStack WebUI WebSocket protocol — conversation core',
    description:
      `Generated from @wrongstack/webui-protocol ${pkg.version} (src/conversation-core.ts, src/error-model.ts). ` +
      'Every frame is a JSON object {type, payload}. A client sends CoreClientMessage and receives CoreServerMessage; ' +
      'other message types exist (see registry.ts) and are not described here.',
    oneOf: [
      { $ref: '#/definitions/CoreClientMessage' },
      { $ref: '#/definitions/CoreServerMessage' },
    ],
    definitions: sortKeys(definitions),
  };
}

const HTTP_TYPES = [
  'ApiErrorBody',
  'ApiSession',
  'ApiSessionAgents',
  'ApiSessionEvents',
  'ApiSessionMessageRequest',
  'ApiSessionMessageResponse',
  'ApiSessionInterruptRequest',
  'ApiSessionInterruptResponse',
];

function openApi() {
  const raw = JSON.stringify(definitionsFor('http-api.ts', HTTP_TYPES)).replaceAll(
    '#/definitions/',
    '#/components/schemas/',
  );
  const schemas = JSON.parse(raw);
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const json = (schema) => ({ 'application/json': { schema } });
  const errors = {
    401: { description: 'The access token is missing or wrong.' },
    403: {
      description: 'The request came from an untrusted browser origin.',
      content: json(ref('ApiErrorBody')),
    },
    500: {
      description: 'The session registry could not be read.',
      content: json(ref('ApiErrorBody')),
    },
  };
  const sessionId = {
    name: 'id',
    in: 'path',
    required: true,
    description: 'Session id (`sess_…`).',
    schema: { type: 'string' },
  };
  const perSession = (summary, okSchema, extra = {}) => ({
    summary,
    parameters: [sessionId, ...(extra.parameters ?? [])],
    ...(extra.requestBody ? { requestBody: extra.requestBody } : {}),
    responses: {
      200: { description: 'OK', content: json(okSchema) },
      400: {
        description: 'Invalid session id or request body.',
        content: json(ref('ApiErrorBody')),
      },
      404: { description: 'No such session.', content: json(ref('ApiErrorBody')) },
      ...errors,
    },
  });
  return {
    openapi: '3.1.0',
    info: {
      title: 'WrongStack WebUI HTTP session API',
      version: pkg.version,
      description:
        'Every live WrongStack session on the machine, read from the cross-process session registry. ' +
        `Generated from @wrongstack/webui-protocol ${pkg.version} (src/http-api.ts).`,
    },
    servers: [{ url: 'http://127.0.0.1:3456' }],
    // Loopback GETs need no token unless the server runs with --require-token.
    security: [{}, { header: [] }, { query: [] }, { cookie: [] }],
    components: {
      securitySchemes: {
        header: { type: 'apiKey', in: 'header', name: 'X-WS-Token' },
        query: { type: 'apiKey', in: 'query', name: 'token' },
        cookie: { type: 'apiKey', in: 'cookie', name: 'ws_token' },
      },
      schemas,
    },
    paths: {
      '/api/sessions': {
        get: {
          summary: 'List live sessions',
          responses: {
            200: { description: 'OK', content: json({ type: 'array', items: ref('ApiSession') }) },
            ...errors,
          },
        },
      },
      '/api/sessions/{id}/agents': {
        get: perSession("A session's agents", ref('ApiSessionAgents')),
      },
      '/api/sessions/{id}/events': {
        get: perSession("A session's recent activity", ref('ApiSessionEvents'), {
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
            },
          ],
        }),
      },
      '/api/sessions/{id}/message': {
        post: perSession('Send a message to the session agent', ref('ApiSessionMessageResponse'), {
          requestBody: { required: true, content: json(ref('ApiSessionMessageRequest')) },
        }),
      },
      '/api/sessions/{id}/interrupt': {
        post: perSession('Interrupt the session agent', ref('ApiSessionInterruptResponse'), {
          requestBody: { required: false, content: json(ref('ApiSessionInterruptRequest')) },
        }),
      },
    },
  };
}

const outputs = {
  'ws-core.schema.json': `${JSON.stringify(wsSchema(), null, 2)}\n`,
  'openapi.json': `${JSON.stringify(openApi(), null, 2)}\n`,
};

if (process.argv.includes('--check')) {
  const stale = Object.entries(outputs).filter(([name, text]) => {
    try {
      return readFileSync(path.join(schemaDir, name), 'utf8').replace(/\r\n/g, '\n') !== text;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(
      `Stale protocol schema: ${stale.map(([n]) => n).join(', ')}. Run bun scripts/generate-protocol-schema.mjs`,
    );
    process.exit(1);
  }
  console.log('protocol schema is current');
} else {
  mkdirSync(schemaDir, { recursive: true });
  for (const [name, text] of Object.entries(outputs))
    writeFileSync(path.join(schemaDir, name), text);
  console.log(`wrote ${Object.keys(outputs).join(', ')} to ${path.relative(root, schemaDir)}`);
}

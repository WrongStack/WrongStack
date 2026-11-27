import { filesOrSources } from '../workflow-runtime/discover.js';
import {
  described,
  filesField,
  read,
  rows,
  str,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'feature-flag-lifecycle',
  description:
    'Maps declared feature flags to literal source references and reports expired flags and definitions without visible consumers',
  tools: [
    {
      name: 'feature_flag_inventory',
      description:
        'Supply flags [{name,expiresAt?,owner?}]; files defaults to the project source files (up to 3000). Reports exact literal-token references, expiry and retirement review candidates; dynamic flag construction is outside scope.',
      properties: {
        flags: {
          type: 'array',
          description: 'Flags {name, expiresAt?, owner?}; expiresAt is an ISO date.',
          items: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              expiresAt: { type: 'string' },
              owner: { type: 'string' },
            },
          },
        },
        files: described(
          filesField,
          'Project-relative files to scan (default: the project source files, up to 3000).',
        ),
      },
      required: ['flags'],
      async run(input, context) {
        const scope = await filesOrSources(input.files, context);
        const files = await Promise.all(
          scope.files.map(async (path) => ({
            path,
            lines: (await read(context.root, path)).split(/\r?\n/),
          })),
        );
        const flags = rows(input.flags).map((flag) => {
          const name = str(flag.name);
          const expiry = flag.expiresAt === undefined ? null : Date.parse(str(flag.expiresAt));
          if (expiry !== null && !Number.isFinite(expiry))
            throw new Error(`Invalid expiry for ${name}`);
          const literal = new RegExp(
            `(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`,
          );
          const references = files.flatMap((file) =>
            file.lines.flatMap((line, index) =>
              literal.test(line) ? [{ path: file.path, line: index + 1 }] : [],
            ),
          );
          return {
            name,
            owner: flag.owner ?? null,
            expired: expiry !== null && expiry <= Date.now(),
            references,
            unusedInScope: !references.length,
          };
        });
        return {
          flags,
          scope: {
            source: scope.source,
            files: scope.files.length,
            ...(scope.truncated ? { truncated: true } : {}),
            ...(scope.skipped ? { skippedUnreadable: scope.skipped } : {}),
          },
          limitation: `Literal references include definitions/comments; absence is scoped to the ${scope.files.length} scanned file(s) and does not prove global non-use.${scope.truncated ? ' The source walk was truncated; unusedInScope may be false positive — pass files to cover the rest.' : ''}`,
        };
      },
    },
  ],
});

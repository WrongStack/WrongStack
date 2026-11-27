import {
  described,
  json,
  object,
  rows,
  str,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'config-migration-assistant',
  description:
    'Previews explicit JSON configuration key renames and defaults while preserving custom values and refusing destination conflicts',
  tools: [
    {
      name: 'config_migration_preview',
      description:
        'Return migrated JSON without writing. renames is [{from,to}] for top-level keys; defaults fill only absent keys. Conflicting destinations reject the migration.',
      properties: {
        path: described(
          stringField,
          'Project-relative JSON config file to migrate. It is read, never written.',
        ),
        renames: {
          type: 'array',
          description: 'Top-level key renames {from, to}. A from key that is absent is skipped.',
          items: {
            type: 'object',
            required: ['from', 'to'],
            properties: { from: stringField, to: stringField },
          },
        },
        defaults: {
          type: 'object',
          description: 'Top-level values to add where the key is still absent after the renames.',
        },
      },
      required: ['path', 'renames'],
      async run(input, context) {
        const original = await json(context.root, input.path);
        const migrated = { ...original };
        const changes = [];
        const reserved = new Set(['__proto__', 'prototype', 'constructor']);
        const renames = rows(input.renames).map((rule) => ({
          from: str(rule.from),
          to: str(rule.to),
        }));
        for (const { from, to } of renames) {
          if (reserved.has(from) || reserved.has(to)) throw new Error('Reserved key');
          if (from === to || !Object.hasOwn(migrated, from)) continue;
          if (Object.hasOwn(migrated, to)) throw new Error(`Destination already exists: ${to}`);
          migrated[to] = migrated[from];
          delete migrated[from];
          changes.push({ operation: 'rename', from, to });
        }
        for (const [key, value] of Object.entries(object(input.defaults ?? {}))) {
          if (reserved.has(key)) throw new Error('Reserved key');
          if (!Object.hasOwn(migrated, key)) {
            migrated[key] = value;
            changes.push({ operation: 'default', to: key });
          }
        }
        return {
          source: input.path,
          changes,
          migrated,
          written: false,
          limitation: 'Explicit top-level transformations; values are not inferred from a schema.',
        };
      },
    },
  ],
});

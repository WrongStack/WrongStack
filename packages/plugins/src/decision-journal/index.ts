import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { restrictFilePermissions } from '@wrongstack/core/security';
import { filesOrChanged } from '../workflow-runtime/discover.js';
import {
  filesField,
  projectPath,
  read,
  str,
  stringField,
  strings,
  workflowPlugin,
} from '../workflow-runtime/index.js';

/** Journal paths already owner-only hardened. F45 (WS-045). */
const hardenedJournals = new Set<string>();

export default workflowPlugin({
  name: 'decision-journal',
  description:
    'Appends explicit architectural decisions and rationales to a project JSONL journal and retrieves decisions linked to changed files',
  tools: [
    {
      name: 'decision_record',
      mutating: true,
      capabilities: ['fs.write'],
      description:
        'Append {title,rationale,files} to an explicit project-contained JSONL journal. Each record has an id and timestamp. Does not inject decisions into prompts automatically.',
      properties: {
        journal: stringField,
        title: stringField,
        rationale: stringField,
        files: filesField,
        supersedes: stringField,
      },
      required: ['journal', 'title', 'rationale', 'files'],
      async run(input, context) {
        const path = projectPath(context.root, input.journal);
        const title = str(input.title);
        const rationale = str(input.rationale);
        if (title.length > 300 || rationale.length > 10000)
          throw new Error('Decision title/rationale exceeds limits');
        const record = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          title,
          rationale,
          files: strings(input.files).map((file) =>
            relative(context.root, projectPath(context.root, file)).replaceAll('\\', '/'),
          ),
          supersedes: input.supersedes === undefined ? null : str(input.supersedes),
        };
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
        // F45 (WS-045 class): on Windows `mode: 0o600` is a no-op, so the
        // decision journal stayed readable by other local accounts where
        // inheritance was not owner-only. Harden once per journal path
        // (best-effort, warned not thrown).
        if (!hardenedJournals.has(path)) {
          hardenedJournals.add(path);
          await restrictFilePermissions(path, { label: 'decision-journal' });
        }
        return record;
      },
    },
    {
      name: 'decision_lookup',
      description:
        'Read a JSONL decision journal; return decisions associated with the given paths (default: the working-tree change), along with explicit supersession links.',
      properties: { journal: stringField, files: filesField },
      required: ['journal'],
      async run(input, context) {
        const scope = await filesOrChanged(input.files, context, 'decision_lookup');
        const files = scope.files.map((file) =>
          relative(context.root, projectPath(context.root, file)).replaceAll('\\', '/'),
        );
        const records = (await read(context.root, input.journal))
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try {
              const parsed = JSON.parse(line) as unknown;
              if (!parsed || typeof parsed !== 'object') return [];
              return [parsed as { id: string; files: string[]; supersedes: string | null }];
            } catch {
              return [];
            }
          });
        const superseded = new Set(records.map((record) => record.supersedes).filter(Boolean));
        return {
          decisions: records
            .filter((record) =>
              record.files.some((path) =>
                files.some((file) => file === path || file.startsWith(`${path}/`)),
              ),
            )
            .map((record) => ({ ...record, superseded: superseded.has(record.id) })),
        };
      },
    },
  ],
});

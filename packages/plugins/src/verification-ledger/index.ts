import { randomUUID } from 'node:crypto';
import { filesOrChanged } from '../workflow-runtime/discover.js';
import {
  commandField,
  filesField,
  fingerprints,
  run,
  str,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';

interface Evidence {
  id: string;
  label: string;
  files: string[];
  hashes: Record<string, string>;
  passed: boolean;
  stable: boolean;
  finishedAt: string;
  command: unknown;
}
export default workflowPlugin({
  name: 'verification-ledger',
  description:
    'Records executed checks with source fingerprints and invalidates their evidence when relevant files change within the host session',
  tools: [
    {
      name: 'verification_record',
      mutating: true,
      description:
        'Execute a check and record its result against the exact supplied source files. Evidence is session-local; include all inputs influencing the check. files defaults to the working-tree change (git diff HEAD + untracked).',
      properties: { command: commandField, files: filesField, label: stringField },
      required: ['command', 'label'],
      async run(input, context) {
        const { files } = await filesOrChanged(input.files, context, 'verification_record');
        const hashes = await fingerprints(context.root, files);
        const execution = await run(input.command, context);
        const current = await fingerprints(context.root, files);
        const record: Evidence = {
          id: randomUUID(),
          label: str(input.label),
          files,
          hashes,
          passed: execution.passed,
          stable: JSON.stringify(hashes) === JSON.stringify(current),
          finishedAt: new Date().toISOString(),
          command: input.command,
        };
        if (context.state.size >= 500) throw new Error('Session ledger is full (500 records)');
        context.state.set(record.id, record);
        return { ...record, execution };
      },
    },
    {
      name: 'verification_status',
      description:
        'Recompute source fingerprints for every recorded check; missing or modified files invalidate previous success.',
      properties: {},
      async run(_input, context) {
        const records = [];
        for (const value of context.state.values()) {
          const record = value as Evidence;
          let current = false;
          try {
            current =
              JSON.stringify(record.hashes) ===
              JSON.stringify(await fingerprints(context.root, record.files));
          } catch {
            /* Missing file invalidates evidence. */
          }
          records.push({
            ...record,
            status: !current || !record.stable ? 'stale' : record.passed ? 'passed' : 'failed',
          });
        }
        return { storage: 'host-session', records };
      },
    },
  ],
});

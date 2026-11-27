import {
  commandField,
  filesField,
  fingerprints,
  rows,
  run,
  str,
  strings,
  workflowPlugin,
} from '../workflow-runtime/index.js';

export default workflowPlugin({
  name: 'acceptance-verifier',
  description:
    'Executes explicit acceptance criteria and maps each requirement to a command result and source fingerprint, preserving missing and stale evidence',
  tools: [
    {
      name: 'acceptance_verify',
      mutating: true,
      description:
        'Verify each named criterion with its supplied command and files. Criteria without commands stay unverified; all must pass on unchanged sources.',
      properties: {
        criteria: {
          type: 'array',
          description:
            'Criteria {id, requirement, command?, files?}. A criterion without command stays unverified; its files are fingerprinted before and after the command.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            required: ['id', 'requirement'],
            properties: {
              id: { type: 'string' },
              requirement: { type: 'string' },
              command: commandField,
              files: filesField,
            },
          },
        },
      },
      required: ['criteria'],
      async run(input, context) {
        const criteria = rows(input.criteria);
        if (!criteria.length || criteria.length > 50)
          throw new Error('Provide 1..50 acceptance criteria');
        const ids = criteria.map((criterion) => str(criterion.id));
        if (new Set(ids).size !== ids.length) throw new Error('Criterion ids must be unique');
        const results = [];
        const evidence = new Map<string, { files: string[]; hashes: Record<string, string> }>();
        for (const criterion of criteria) {
          const id = str(criterion.id);
          const requirement = str(criterion.requirement);
          if (!criterion.command) {
            results.push({ id, requirement, status: 'unverified' });
            continue;
          }
          const files = strings(criterion.files);
          const hashes = await fingerprints(context.root, files);
          evidence.set(id, { files, hashes });
          const execution = await run(criterion.command, context);
          const stable =
            JSON.stringify(hashes) === JSON.stringify(await fingerprints(context.root, files));
          results.push({
            id,
            requirement,
            status: !stable ? 'stale' : execution.passed ? 'passed' : 'failed',
            hashes,
            execution,
          });
        }
        // Later criteria may change inputs validated by earlier criteria.
        for (const result of results) {
          const captured = evidence.get(result.id);
          if (!captured) continue;
          try {
            if (
              JSON.stringify(captured.hashes) !==
              JSON.stringify(await fingerprints(context.root, captured.files))
            )
              result.status = 'stale';
          } catch {
            result.status = 'stale';
          }
        }
        return { accepted: results.every((item) => item.status === 'passed'), criteria: results };
      },
    },
  ],
});

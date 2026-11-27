import {
  digest,
  readBytes,
  rows,
  str,
  strings,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'generated-artifact-tracker',
  description:
    'Tracks source and generated-output fingerprints for declared generators and reports which artifacts need regeneration after changes',
  tools: [
    {
      name: 'generated_artifacts',
      description:
        'action=capture records a caller-approved source/output baseline in this host session. action=check compares it. rules: [{id,inputs,outputs,command}]. Capture does not prove a generator was run.',
      properties: {
        action: {
          type: 'string',
          enum: ['capture', 'check'],
          description:
            'capture records the current fingerprints; check compares the files against the last capture.',
        },
        rules: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Generators {id, inputs, outputs, command?}: inputs and outputs are project-relative file lists; command is recorded with the baseline, not run.',
        },
      },
      required: ['action', 'rules'],
      async run(input, context) {
        if (!['capture', 'check'].includes(str(input.action))) throw new Error('Unknown action');
        const results = [];
        for (const rule of rows(input.rules)) {
          const id = str(rule.id);
          const inputs = strings(rule.inputs);
          const outputs = strings(rule.outputs);
          if (!inputs.length || !outputs.length)
            throw new Error('Each generator requires inputs and outputs');
          const snapshot = [];
          for (const path of [...inputs, ...outputs]) {
            try {
              snapshot.push({ path, hash: digest(await readBytes(context.root, path)) });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              snapshot.push({ path, hash: null });
            }
          }
          const signature = JSON.stringify({ inputs, outputs, command: rule.command, snapshot });
          const previous = context.state.get(id);
          if (input.action === 'capture') {
            if (context.state.size >= 500 && !context.state.has(id))
              throw new Error('Too many generator baselines');
            context.state.set(id, signature);
          }
          results.push({
            id,
            status: snapshot.some((file) => file.hash === null)
              ? 'missing-file'
              : input.action === 'capture'
                ? 'baseline-captured'
                : previous === undefined
                  ? 'no-baseline'
                  : previous === signature
                    ? 'unchanged'
                    : 'regeneration-required',
            command: rule.command,
            snapshot,
          });
        }
        return { storage: 'host-session', generators: results };
      },
    },
  ],
});

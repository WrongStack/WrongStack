import { read, run, stringField, workflowPlugin } from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'executable-documentation',
  description:
    'Executes explicitly marked JavaScript documentation examples in Node and records their actual exit status and source location',
  tools: [
    {
      name: 'documentation_verify',
      mutating: true,
      description:
        'Run only fenced blocks beginning ```js verify or ```javascript verify from the selected Markdown file (default: README.md). Executes with Node ESM in the project directory; examples should contain assertions.',
      properties: { path: stringField },
      async run(input, context) {
        const docPath = input.path ?? 'README.md';
        const source = await read(context.root, docPath);
        const blocks = [
          ...source.matchAll(/^```(?:js|javascript) verify\s*\r?\n([\s\S]*?)^```\s*$/gm),
        ];
        if (blocks.length > 50) throw new Error('At most 50 executable examples');
        const results = [];
        for (const block of blocks) {
          const line = source.slice(0, block.index).split('\n').length;
          const execution = await run(
            {
              program: process.execPath,
              args: ['--input-type=module', '-e', block[1]!],
              timeoutMs: 10000,
            },
            context,
          );
          results.push({ line, execution, passed: execution.passed });
        }
        return {
          status: !results.length
            ? 'no-executable-examples'
            : results.every((item) => item.passed)
              ? 'passed'
              : 'failed',
          examples: results,
          source: docPath,
        };
      },
    },
  ],
});

import { advice, reviewField } from '../workflow-runtime/advice.js';
import { filesOrChanged } from '../workflow-runtime/discover.js';
import {
  commandField,
  described,
  digest,
  filesField,
  fingerprints,
  object,
  run,
  str,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';

export default workflowPlugin({
  name: 'bug-reproducer',
  description:
    'Runs a supplied regression command twice against fingerprinted files and distinguishes a reproducible failure from instability or infrastructure errors',
  tools: [
    {
      name: 'bug_reproduce',
      mutating: true,
      description:
        'Run an explicit regression command twice. expectedOutput is a literal failure marker required to attribute the failure to the reported bug. files defaults to the working-tree change (git diff HEAD + untracked). Returns a portable Node test recipe and file fingerprints.',
      properties: {
        command: described(
          commandField,
          'Reproducer command, run twice; it should fail while the bug exists.',
        ),
        files: described(
          filesField,
          'Files to fingerprint before and after the run (default: the working-tree change, git diff HEAD + untracked).',
        ),
        expectedOutput: described(
          stringField,
          'Literal text the failing run prints to stdout or stderr. Both runs must contain it to count as reproduced.',
        ),
        review: reviewField,
      },
      required: ['command', 'expectedOutput'],
      async run(input, context) {
        const { files, source } = await filesOrChanged(input.files, context, 'bug_reproduce');
        const before = await fingerprints(context.root, files);
        const marker = str(input.expectedOutput);
        const first = await run(input.command, context);
        const second = await run(input.command, context);
        const after = await fingerprints(context.root, files);
        const stable = JSON.stringify(before) === JSON.stringify(after);
        const matches = [first, second].map(
          (result) =>
            !result.passed &&
            !result.spawnError &&
            !result.timedOut &&
            result.code !== null &&
            `${result.stdout}\n${result.stderr}`.includes(marker),
        );
        const command = object(input.command);
        const recipe = `import { spawnSync } from 'node:child_process';\nimport assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('regression must be fixed', () => {\n  const result = spawnSync(${JSON.stringify(str(command.program))}, ${JSON.stringify(command.args ?? [])}, { encoding: 'utf8', timeout: 60000, shell: false });\n  assert.ifError(result.error);\n  assert.equal(result.status, 0, result.stdout + result.stderr);\n});\n`;
        const report = {
          status: !stable
            ? 'files-changed-during-run'
            : matches.every(Boolean)
              ? 'reproduced'
              : matches.some(Boolean)
                ? 'unstable'
                : 'not-reproduced',
          fingerprints: before,
          filesSource: source,
          runs: [first, second],
          marker,
          recipe,
          recipeHash: digest(recipe),
          recipeCwd: first.cwd,
          limitation:
            'Caller supplies the reproducer command and failure marker; the generated Node test asserts its eventual zero exit status.',
        };
        return {
          ...report,
          advice: await advice(
            input.review,
            { status: report.status, stable, attempts: matches },
            context,
          ),
        };
      },
    },
  ],
});

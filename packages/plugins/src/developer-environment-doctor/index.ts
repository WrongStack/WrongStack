import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { json, run, stringField, workflowPlugin } from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'developer-environment-doctor',
  description:
    'Probes the active Node runtime, declared package-manager launcher and dependency-install presence using the project package manifest',
  tools: [
    {
      name: 'developer_environment_check',
      mutating: true,
      description:
        'Probe Node and the declared npm/pnpm/yarn/bun launcher with --version; compare exact packageManager pin and detect a missing node_modules. Engine ranges are reported, not guessed. manifest defaults to the project root package.json.',
      properties: { manifest: stringField },
      async run(input, context) {
        const manifest = await json(context.root, input.manifest ?? 'package.json');
        const declaration =
          typeof manifest.packageManager === 'string' ? manifest.packageManager : null;
        const manager = declaration?.split('@')[0] ?? null;
        const node = await run(
          { program: process.execPath, args: ['--version'], timeoutMs: 5000 },
          context,
        );
        let launcher = null;
        if (manager && ['npm', 'pnpm', 'yarn', 'bun'].includes(manager))
          launcher = await run({ program: manager, args: ['--version'], timeoutMs: 5000 }, context);
        let installed = true;
        try {
          await access(join(context.root, 'node_modules'));
        } catch {
          installed = false;
        }
        const expectedVersion = declaration?.slice(declaration.indexOf('@') + 1).split('+')[0];
        const issues = [];
        if (!installed) issues.push('node_modules is absent at the project root');
        if (!declaration) issues.push('packageManager is not declared');
        if (manager && !launcher) issues.push('unsupported package-manager launcher');
        if (launcher && !launcher.passed) issues.push('package-manager launcher failed');
        if (launcher?.passed && launcher.stdout.trim() !== expectedVersion)
          issues.push(`package-manager version differs from ${expectedVersion}`);
        return {
          node,
          packageManager: launcher,
          declaration,
          engines: manifest.engines ?? {},
          installed,
          issues,
          limitation:
            'Engine expressions and native addon ABI compatibility require the package manager and project tests.',
        };
      },
    },
  ],
});

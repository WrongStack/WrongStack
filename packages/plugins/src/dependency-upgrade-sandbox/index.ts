import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  described,
  filesField,
  json,
  object,
  projectPath,
  rows,
  run,
  str,
  stringField,
  strings,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'dependency-upgrade-sandbox',
  description:
    'Copies selected fixture files to a temporary directory, changes one npm dependency, installs without lifecycle scripts and runs explicit validation commands',
  tools: [
    {
      name: 'dependency_upgrade_try',
      mutating: true,
      description:
        'For standalone npm packages: copy files (must include package.json), update dependency to an exact version, npm install --ignore-scripts, then run checks. Original files stay unchanged; temporary files are removed afterward. This is directory isolation, not an OS security sandbox.',
      properties: {
        files: described(
          filesField,
          'Project-relative files copied to the temporary directory. Must include package.json; add the lockfile and the sources the checks need.',
        ),
        dependency: described(
          stringField,
          'Name of a dependency already declared in package.json.',
        ),
        version: described(stringField, 'Exact semver version to install, e.g. 1.2.3.'),
        registry: {
          type: 'string',
          description:
            'Optional HTTP(S) npm registry without embedded credentials; useful for private/offline test registries.',
        },
        checks: {
          type: 'array',
          items: { type: 'object' },
          description:
            '1..20 commands {program, args?, cwd?, timeoutMs?} run in the temporary directory after the install.',
        },
      },
      required: ['files', 'dependency', 'version', 'checks'],
      async run(input, context) {
        const files = strings(input.files);
        const dependency = str(input.dependency);
        const version = str(input.version);
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
          throw new Error('Provide an exact semver version');
        if (!files.includes('package.json')) throw new Error('files must include package.json');
        const manifest = await json(context.root, 'package.json');
        const section = ['dependencies', 'devDependencies', 'optionalDependencies'].find((key) =>
          Object.hasOwn(object(manifest[key] ?? {}), dependency),
        );
        if (!section) throw new Error('Dependency is not declared');
        if (manifest.workspaces || JSON.stringify(manifest).includes('workspace:'))
          throw new Error('Workspace packages need a standalone reproduction fixture');
        const checks = rows(input.checks);
        if (!checks.length || checks.length > 20) throw new Error('Supply 1..20 checks');
        const registry = input.registry === undefined ? null : new URL(str(input.registry));
        if (
          registry &&
          (!['http:', 'https:'].includes(registry.protocol) ||
            registry.username ||
            registry.password)
        )
          throw new Error('Registry must be HTTP(S) without embedded credentials');
        const temporary = await mkdtemp(join(tmpdir(), 'wrongstack-upgrade-'));
        try {
          for (const file of files) {
            if (
              /(^|[\\/])(?:\.env(?:\.|$)|\.npmrc$|\.git(?:[\\/]|$)|node_modules(?:[\\/]|$))/.test(
                file,
              )
            )
              throw new Error('Do not copy credentials, .git or node_modules');
            const source = projectPath(context.root, file);
            const name = relative(context.root, source);
            const destination = projectPath(temporary, name);
            await mkdir(dirname(destination), { recursive: true });
            await copyFile(source, destination);
          }
          const previousVersion = object(manifest[section])[dependency];
          manifest[section] = { ...object(manifest[section]), [dependency]: version };
          await writeFile(join(temporary, 'package.json'), JSON.stringify(manifest, null, 2));
          const isolated = { ...context, root: temporary };
          const install = await run(
            {
              program: 'npm',
              args: [
                'install',
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                ...(registry ? ['--registry', registry.href] : []),
              ],
              timeoutMs: 120000,
            },
            isolated,
          );
          const results = [];
          if (install.passed) for (const check of checks) results.push(await run(check, isolated));
          return {
            dependency,
            previousVersion,
            version,
            passed:
              install.passed &&
              results.length === checks.length &&
              results.every((result) => result.passed),
            install,
            checks: results,
            limitation:
              'Fresh temporary install; native dependencies requiring install scripts may fail. Explicit checks execute with normal user permissions.',
          };
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
    },
  ],
});

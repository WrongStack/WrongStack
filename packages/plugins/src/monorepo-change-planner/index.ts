import { dirname } from 'node:path';
import { advice, reviewField } from '../workflow-runtime/advice.js';
import { filesOrChanged, workspaceManifests } from '../workflow-runtime/discover.js';
import { cycles } from '../workflow-runtime/graph.js';
import { filesField, json, object, strings, workflowPlugin } from '../workflow-runtime/index.js';

export default workflowPlugin({
  name: 'monorepo-change-planner',
  description:
    'Computes transitive workspace consumers and dependency-first validation order from the workspace manifests and the working-tree change (or supplied lists)',
  tools: [
    {
      name: 'monorepo_change_plan',
      description:
        'Plan validation for a change. manifests defaults to every declared workspace package.json, changedFiles to the working-tree change (git diff HEAD + untracked). Returns impacted packages, dependency-first build/test recipes, cycles and changes outside any package.',
      properties: { manifests: filesField, changedFiles: filesField, review: reviewField },
      async run(input, context) {
        const manifests =
          input.manifests === undefined
            ? await workspaceManifests(context)
            : strings(input.manifests);
        // A clean tree is a valid "nothing to validate" answer here.
        const changedInput = await filesOrChanged(
          input.changedFiles,
          context,
          'monorepo_change_plan',
          { allowEmpty: true, includeDeleted: true },
        );
        const packages = await Promise.all(
          manifests.map(async (path) => {
            const manifest = await json(context.root, path);
            if (typeof manifest.name !== 'string') throw new Error(`Package name missing: ${path}`);
            return {
              name: manifest.name,
              // Same `./` normalization as changedFiles below (F1117).
              dir: dirname(path).replaceAll('\\', '/').replace(/^\.\//, ''),
              dependencies: Object.keys({
                ...object(manifest.dependencies ?? {}),
                ...object(manifest.devDependencies ?? {}),
                ...object(manifest.peerDependencies ?? {}),
                ...object(manifest.optionalDependencies ?? {}),
              }),
              scripts: object(manifest.scripts ?? {}),
              private: manifest.private === true,
            };
          }),
        );
        const names = new Set(packages.map((pkg) => pkg.name));
        if (names.size !== packages.length) throw new Error('Duplicate workspace package names');
        const edges = new Map(
          packages.map((pkg) => [pkg.name, pkg.dependencies.filter((name) => names.has(name))]),
        );
        const changed = changedInput.files.map((path) =>
          path.replaceAll('\\', '/').replace(/^\.\//, ''),
        );
        const affected = new Set(
          packages
            .filter((pkg) =>
              changed.some((path) => pkg.dir === '.' || path.startsWith(`${pkg.dir}/`)),
            )
            .map((pkg) => pkg.name),
        );
        const direct = [...affected];
        let grew = true;
        while (grew) {
          grew = false;
          for (const [name, deps] of edges)
            if (!affected.has(name) && deps.some((dep) => affected.has(dep))) {
              affected.add(name);
              grew = true;
            }
        }
        const order: string[] = [];
        const seen = new Set<string>();
        function visit(name: string) {
          if (seen.has(name)) return;
          seen.add(name);
          for (const dependency of edges.get(name) ?? []) visit(dependency);
          order.push(name);
        }
        for (const name of affected) visit(name);
        const report = {
          directlyChanged: direct,
          affected: [...affected],
          cycles: cycles(edges),
          validationOrder: order.map((name) => {
            const pkg = packages.find((candidate) => candidate.name === name)!;
            return {
              name,
              cwd: pkg.dir,
              scripts: ['build', 'typecheck', 'test'].filter(
                (script) => typeof pkg.scripts[script] === 'string',
              ),
              publishCandidate: affected.has(name) && !pkg.private,
            };
          }),
          unknownChanges: changed.filter(
            (path) => !packages.some((pkg) => pkg.dir === '.' || path.startsWith(`${pkg.dir}/`)),
          ),
          inputs: {
            manifests: input.manifests === undefined ? 'workspace' : 'supplied',
            changedFiles: changedInput.source,
          },
          limitation:
            'Publish candidates require release-policy review; changes outside the package directories (root config, CI) are listed as unknownChanges, not attributed.',
        };
        return { ...report, advice: await advice(input.review, report, context) };
      },
    },
  ],
});

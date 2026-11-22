import { dirname } from 'node:path';
import { filesField, json, object, strings, workflowPlugin } from '../workflow-runtime/index.js';
import { cycles } from '../workflow-runtime/graph.js';
import { advice, reviewField } from '../workflow-runtime/advice.js';
export default workflowPlugin({
  name: 'monorepo-change-planner',
  description:
    'Computes transitive workspace consumers and dependency-first validation order from explicit package manifests and changed paths',
  tools: [
    {
      name: 'monorepo_change_plan',
      description:
        'Supply workspace package.json paths and changed files. Returns impacted packages, dependency-first build/test recipes, cycles and unknown changes.',
      properties: { manifests: filesField, changedFiles: filesField, review: reviewField },
      required: ['manifests', 'changedFiles'],
      async run(input, context) {
        const manifests = strings(input.manifests);
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
        const changed = strings(input.changedFiles).map((path) =>
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
          limitation:
            'Publish candidates require release-policy review; changes outside supplied package directories are not attributed.',
        };
        return { ...report, advice: await advice(input.review, report, context) };
      },
    },
  ],
});

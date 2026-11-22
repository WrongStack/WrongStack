import { filesField, rows, str, strings, workflowPlugin } from '../workflow-runtime/index.js';
import { cycles, importGraph } from '../workflow-runtime/graph.js';
export default workflowPlugin({
  name: 'architecture-boundary-checker',
  description:
    'Builds a literal source import graph, reports dependency cycles, and checks explicitly forbidden directory boundaries',
  tools: [
    {
      name: 'architecture_boundaries',
      description:
        'Inspect imports in the supplied files. forbidden contains {from,to} directory prefixes; unresolved external/alias imports remain visible.',
      properties: {
        files: filesField,
        forbidden: {
          type: 'array',
          items: {
            type: 'object',
            required: ['from', 'to'],
            properties: { from: { type: 'string' }, to: { type: 'string' } },
          },
        },
      },
      required: ['files', 'forbidden'],
      async run(input, context) {
        const graph = await importGraph(context.root, strings(input.files));
        // Same spelling normalization importGraph applies to the files (F1118).
        const prefix = (value: unknown) =>
          str(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
        const rules = rows(input.forbidden).map((rule) => ({
          from: prefix(rule.from),
          to: prefix(rule.to),
        }));
        const within = (path: string, prefix: string) =>
          path === prefix || path.startsWith(`${prefix}/`);
        const violations = [...graph.edges].flatMap(([from, targets]) =>
          targets
            .filter((to) => rules.some((rule) => within(from, rule.from) && within(to, rule.to)))
            .map((to) => ({ from, to })),
        );
        return {
          violations,
          cycles: cycles(graph.edges),
          edges: Object.fromEntries(graph.edges),
          unresolved: graph.unresolved,
          limitation: graph.limitation,
        };
      },
    },
  ],
});

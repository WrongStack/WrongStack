import {
  described,
  json,
  rows,
  str,
  stringField,
  strings,
  workflowPlugin,
} from '../workflow-runtime/index.js';

export default workflowPlugin({
  name: 'runtime-trace-explorer',
  description:
    'Reconstructs parent-child runtime spans from a local trace export and identifies broken ancestry, failed spans and missing expected layers',
  tools: [
    {
      name: 'runtime_trace_explore',
      description:
        'Read JSON {spans:[{id,parentId?,traceId,layer,startMs,endMs,status}]} and inspect one trace. Optional layers declares required UI/API/service/storage stages.',
      properties: {
        path: described(stringField, 'Project-relative JSON trace export with a spans array.'),
        traceId: described(stringField, 'Trace to inspect; spans of other traces are ignored.'),
        layers: {
          type: 'array',
          items: stringField,
          description: 'Layer names that must appear in the trace, e.g. ["ui", "api", "storage"].',
        },
      },
      required: ['path', 'traceId'],
      async run(input, context) {
        const trace = str(input.traceId);
        const spans = rows((await json(context.root, input.path)).spans).filter(
          (span) => span.traceId === trace,
        );
        const ids = spans.map((span) => str(span.id));
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate span id');
        const byId = new Map(spans.map((span) => [str(span.id), span]));
        const issues: Array<{ id: string; issue: string }> = [];
        for (const span of spans) {
          const id = str(span.id);
          if (
            typeof span.startMs !== 'number' ||
            typeof span.endMs !== 'number' ||
            !Number.isFinite(span.startMs) ||
            !Number.isFinite(span.endMs) ||
            span.endMs < span.startMs
          )
            issues.push({ id, issue: 'invalid-timing' });
          if (span.parentId && !byId.has(str(span.parentId)))
            issues.push({ id, issue: 'missing-parent' });
          if (span.status === 'error') issues.push({ id, issue: 'error-span' });
          const seen = new Set([id]);
          let parent = span.parentId;
          while (parent && byId.has(str(parent))) {
            const key = str(parent);
            if (seen.has(key)) {
              issues.push({ id, issue: 'parent-cycle' });
              break;
            }
            seen.add(key);
            parent = byId.get(key)?.parentId;
          }
        }
        const expected = input.layers === undefined ? [] : strings(input.layers);
        const missingLayers = expected.filter(
          (layer) => !spans.some((span) => span.layer === layer),
        );
        return {
          status: !spans.length
            ? 'no-evidence'
            : issues.length || missingLayers.length
              ? 'issues-found'
              : 'inspected',
          spans,
          issues,
          missingLayers,
          source: input.path,
        };
      },
    },
  ],
});

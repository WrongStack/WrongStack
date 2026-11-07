import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderInstructionLayer } from '../../src/core/instruction-template.js';

const text = ['availability', 'tool-landscape']
  .map((name) =>
    readFileSync(new URL(`../../instructions/shared/system/${name}.md`, import.meta.url), 'utf8'),
  )
  .join('\n');

function render(names: string[]) {
  return renderInstructionLayer(text, {
    toolNames: new Set(names),
    tier: 'minimal',
    subagent: false,
    strictToolReferences: true,
  });
}

describe('Project Kit model guidance', () => {
  it('leaves deferred execution to the registry rather than duplicating its schema', () => {
    const output = render(['project_kit', 'tool_search', 'tool_use']);
    expect(output).toContain('Project Kit holds reusable project operations');
    expect(output).toContain('Discover deferred tools with `tool_search`');
    expect(output).toContain('using the returned `inputSchema`');
    expect(output).not.toContain('`project_kit_run`');
    expect(output).not.toContain('Before writing an ad hoc script');
  });

  it('omits unavailable capabilities and does not inject executor instructions', () => {
    expect(render(['project_kit', 'project_kit_run'])).toContain(
      'Project Kit holds reusable project operations',
    );
    expect(render(['project_kit', 'project_kit_run'])).not.toContain('Use `project_kit_run`');
    expect(render([])).not.toContain('Project Kit');
    expect(render([])).not.toContain('`project_kit`');
  });
});

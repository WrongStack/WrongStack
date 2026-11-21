import { browserTools } from '@wrongstack/browser-tools/tools';
import { describe, expect, it } from 'vitest';
import { builtinTools } from '../src/builtin.js';
import { clarifyTool } from '../src/clarify.js';
import { KANBAN_INPUT_SCHEMA } from '../src/kanban-tool-schema.js';

// `| undefined` on both optional members is required: the callers pass
// `JSONSchema`, whose own members are optional-and-undefined, and the package
// compiles with `exactOptionalPropertyTypes`.
function undocumentedTopLevelFields(schema: {
  properties?: Record<string, { description?: string | undefined }> | undefined;
}) {
  return Object.entries(schema.properties ?? {})
    .filter(([, property]) => !property.description?.trim())
    .map(([name]) => name);
}

describe('high-branching tool schema descriptions', () => {
  it('documents every top-level built-in parameter', () => {
    for (const tool of builtinTools) {
      expect(undocumentedTopLevelFields(tool.inputSchema), tool.name).toEqual([]);
    }
  });

  it('documents every browser action parameter', () => {
    for (const tool of browserTools) {
      expect(undocumentedTopLevelFields(tool.inputSchema), tool.name).toEqual([]);
    }
  });

  it('documents every top-level clarify form parameter', () => {
    expect(undocumentedTopLevelFields(clarifyTool.inputSchema)).toEqual([]);
  });

  it('documents every top-level Kanban action parameter', () => {
    expect(undocumentedTopLevelFields(KANBAN_INPUT_SCHEMA)).toEqual([]);
  });
});

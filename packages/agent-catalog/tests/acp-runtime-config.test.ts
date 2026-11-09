import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadProjectAgentConfig } from '../src/project-agent-config-io.js';
import { validateProjectAgentConfig } from '../src/project-agent-config-validation.js';
import { updateProjectAgentConfig } from '../src/project-agent-files.js';
import { applyProjectAgentConfig } from '../src/project-agent-roster.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('persists and applies internal ACP model settings from a roster role customization', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrongstack-roster-acp-'));
  roots.push(root);
  const selected = {
    modelRuntime: { acp: { fixture: { engine: 'deep', thought: 'ultra' } } },
    provider: 'acp',
    model: 'fixture',
  };
  updateProjectAgentConfig('reviewer', selected, root);
  const restored = loadProjectAgentConfig('reviewer', root);
  expect(restored).toEqual(selected);
  const applied = applyProjectAgentConfig(
    { id: 'worker', name: 'Worker', prompt: '', modelRuntime: { parameters: { user: 'fixture' } } },
    restored,
  );
  expect(applied.modelRuntime).toEqual({
    parameters: { user: 'fixture' },
    acp: selected.modelRuntime.acp,
  });
  selected.modelRuntime.acp.fixture.engine = 'changed';
  expect(applied.modelRuntime?.acp?.fixture?.engine).toBe('deep');
});
it('rejects malformed ACP values and unrelated runtime fields before saving a role', () => {
  expect(() =>
    validateProjectAgentConfig({ modelRuntime: { acp: { fixture: { thought: 4 } } } }),
  ).toThrow('bounded strings');
  expect(() => validateProjectAgentConfig({ modelRuntime: { arbitrary: true } })).toThrow(
    'ACP settings only',
  );
});

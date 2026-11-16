import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProjectContextualizedPrompt,
  loadRoleKnowledgeManifest,
} from '../src/project-agent-identity.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('loadRoleKnowledgeManifest prototype safety', () => {
  it('ignores __proto__ keys in liveQueries without polluting prototype', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cat-know-'));
    tempRoots.push(root);
    const dir = path.join(root, '.wrongstack', 'agents', 'coder');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'knowledge.json'),
      '{"liveQueries":{"__proto__":{"registry":"npm","key":"evil"}}}',
    );

    const manifest = loadRoleKnowledgeManifest('coder', root);
    expect(
      (manifest?.liveQueries as unknown as Record<string, unknown>)?.['registry'],
    ).toBeUndefined();
  });

  it('returns undefined for Object.prototype role names instead of prototype functions', () => {
    for (const role of ['toString', 'constructor', 'valueOf']) {
      expect(loadRoleKnowledgeManifest(role)).toBeUndefined();
      expect(() => buildProjectContextualizedPrompt('Base instructions', role)).not.toThrow();
    }
  });

  it('loads BOM-prefixed knowledge.json manifests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cat-know-bom-'));
    tempRoots.push(root);
    const dir = path.join(root, '.wrongstack', 'agents', 'custom-bom');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'knowledge.json'),
      `\uFEFF${JSON.stringify({ checklist: ['Check registry'], liveQueries: {} })}`,
      'utf8',
    );

    const manifest = loadRoleKnowledgeManifest('custom-bom', root);
    expect(manifest?.checklist).toEqual(['Check registry']);
  });

  it('loads BOM-prefixed profile.json files', async () => {
    const { loadProjectAgentProfile } = await import('../src/project-agent-profile.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cat-prof-bom-'));
    tempRoots.push(root);
    const dir = path.join(root, '.wrongstack', 'agents', 'reviewer-bom');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'profile.json'),
      `\uFEFF${JSON.stringify({
        role: 'reviewer-bom',
        name: 'Reviewer BOM',
        baseRole: 'generic',
        purpose: 'Review carefully',
        taskTypes: ['review'],
      })}`,
      'utf8',
    );

    expect(loadProjectAgentProfile('reviewer-bom', root)?.name).toBe('Reviewer BOM');
  });
});

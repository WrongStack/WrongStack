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
});

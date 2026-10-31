import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseWrongForgeInfo,
  readCachedWrongForgeInfo,
  writeWrongForgeInfoCache,
} from '@wrongstack/fleet';
import { describe, expect, it } from 'vitest';

describe('WrongForge model capabilities', () => {
  it('keeps model effort levels and descriptions through the info cache', () => {
    const body = {
      models: ['a', 'b'],
      default_model: 'a',
      effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max', 'off'] },
      model_details: [
        { id: 'a', description: 'Reasoning model', effort_levels: ['low', 'high'] },
        { id: 'b', description: 'Plain model', effort_levels: [] },
      ],
    };
    const info = parseWrongForgeInfo(body);
    expect(info).toMatchObject({
      models: ['a', 'b'],
      defaultModel: 'a',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'off'],
      modelDetails: [
        { id: 'a', description: 'Reasoning model', effortLevels: ['low', 'high'] },
        { id: 'b', description: 'Plain model', effortLevels: [] },
      ],
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-info-'));
    try {
      const file = path.join(dir, 'info.json');
      writeWrongForgeInfoCache(info, file);
      expect(readCachedWrongForgeInfo(file)).toEqual(info);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('accepts older servers without model_details', () => {
    expect(parseWrongForgeInfo({ models: ['a'] })).toEqual({ models: ['a'], features: [] });
  });
});

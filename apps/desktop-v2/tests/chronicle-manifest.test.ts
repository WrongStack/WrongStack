import { describe, expect, it } from 'vitest';
import { chronicleManifest, withoutManifest } from '../src/chronicle-manifest';

describe('Chronicle prompt manifest view', () => {
  const attributes = {
    status: 200,
    promptManifest: {
      manifestId: 'prompt_abc',
      messageCount: 12,
      estimatedMessageTokens: 3400,
      contentBytes: 14000,
      roleCounts: { user: 5, assistant: 6, system: 1 },
      blockCounts: { text: 10, tool_use: 3 },
      system: {
        blockCount: 2,
        bytes: 900,
        hash: 'sys0123456789abcdef',
        blocks: [
          { source: 'identity', bytes: 400, hash: 'h1' },
          { bytes: 500, hash: 'h2' },
        ],
      },
      messages: [{ index: 11, role: 'user', bytes: 40, hash: 'm11' }],
      messagesTruncated: 4,
      tools: {
        count: 3,
        estimatedDefinitionTokens: 800,
        manifestHash: 'tools1',
        namesRef: 'tools1',
      },
    },
  };

  it('reads the recorded manifest without recomputing anything', () => {
    const view = chronicleManifest(attributes)!;
    expect(view.manifestId).toBe('prompt_abc');
    expect(view.roles[0]).toEqual(['assistant', 6]);
    expect(view.system.blocks).toEqual([
      { source: 'identity', bytes: 400, hash: 'h1' },
      { source: 'unlabelled', bytes: 500, hash: 'h2' },
    ]);
    expect(view.messages).toEqual([
      { index: 11, role: 'user', bytes: 40, estimatedTokens: null, hash: 'm11' },
    ]);
    expect(view.messagesOmitted).toBe(4);
    // Names stored on an earlier request are referenced, not invented.
    expect(view.tools.names).toBeNull();
    expect(view.tools.namesRef).toBe('tools1');
    expect(view.tools.mutating).toBeNull();
  });

  it('keeps older manifests without block composition distinguishable', () => {
    const old = chronicleManifest({
      promptManifest: { manifestId: 'p', system: { blockCount: 1 }, tools: { names: ['read'] } },
    })!;
    expect(old.system.blocks).toBeNull();
    expect(old.tools.names).toEqual(['read']);
    expect(old.messageCount).toBeNull();
  });

  it('moves only a real manifest out of the generic evidence list', () => {
    expect(withoutManifest(attributes)).toEqual({ status: 200 });
    expect(withoutManifest({ promptManifest: { size: 1 } })).toEqual({
      promptManifest: { size: 1 },
    });
    expect(chronicleManifest({ promptManifest: 'x' })).toBeNull();
  });
});

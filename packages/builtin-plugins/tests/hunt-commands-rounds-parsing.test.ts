import type { PromptLoader } from '@wrongstack/contracts/types/prompt';
import { describe, expect, it } from 'vitest';
import { buildProofDrivenHuntCommands } from '../src/hunt-commands.js';

function createLoader(): PromptLoader {
  return {
    find: async (slug: string) => ({
      id: slug,
      slug,
      title: slug,
      description: '',
      content: 'PROMPT BODY',
      category: 'coding',
      tags: [],
      source: 'builtin',
      favorite: false,
      createdAt: '',
      updatedAt: '',
    }),
  } as unknown as PromptLoader;
}

function createContext() {
  return {
    messages: [],
    meta: {},
    session: { id: 'hunt-rounds-test', append: async () => undefined },
  } as never;
}

describe('hunt-commands --rounds argument parsing', () => {
  const bughunt = buildProofDrivenHuntCommands(
    () => createLoader(),
    () => null,
  ).find((c) => c.name === 'bughunt')!;

  it('parses leading and trailing --rounds flags in both space and equals forms', async () => {
    const leadSpace = (await bughunt.run('--rounds 5 packages/core', createContext())) as {
      message?: string;
      metadata?: { bugHunt?: { rounds?: number } };
    };
    expect(leadSpace.metadata?.bugHunt?.rounds).toBe(5);
    expect(leadSpace.message).toBe('Proof-Driven Bug Hunter started for: packages/core');

    const leadEq = (await bughunt.run('--rounds=12 packages/fleet', createContext())) as {
      message?: string;
      metadata?: { bugHunt?: { rounds?: number } };
    };
    expect(leadEq.metadata?.bugHunt?.rounds).toBe(12);
    expect(leadEq.message).toBe('Proof-Driven Bug Hunter started for: packages/fleet');

    const trailSpace = (await bughunt.run('packages/core --rounds 7', createContext())) as {
      message?: string;
      metadata?: { bugHunt?: { rounds?: number } };
    };
    expect(trailSpace.metadata?.bugHunt?.rounds).toBe(7);
    expect(trailSpace.message).toBe('Proof-Driven Bug Hunter started for: packages/core');

    const trailEq = (await bughunt.run('packages/core auth flow --rounds=25', createContext())) as {
      message?: string;
      metadata?: { bugHunt?: { rounds?: number } };
    };
    expect(trailEq.metadata?.bugHunt?.rounds).toBe(25);
    expect(trailEq.message).toBe('Proof-Driven Bug Hunter started for: packages/core auth flow');
  });

  it('rejects missing, empty, non-decimal, out-of-range, and duplicate --rounds flags', async () => {
    for (const bad of [
      '--rounds',
      '--rounds=',
      'packages/core --rounds',
      'packages/core --rounds=',
      '--rounds 0',
      '--rounds 26',
      '--rounds -3',
      '--rounds 0x5',
      '--rounds 1e1',
      '--rounds 05',
      '--rounds 3 --rounds 5',
    ]) {
      const res = (await bughunt.run(bad, createContext())) as {
        message?: string;
        runText?: string;
      };
      expect(res.message, `expected usage error for "${bad}"`).toContain('Usage: /bughunt');
      expect(res.runText, `expected no runText for "${bad}"`).toBeUndefined();
    }
  });
});

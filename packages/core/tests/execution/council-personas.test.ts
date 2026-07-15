import { describe, expect, it } from 'vitest';
import {
  BUILTIN_COUNCIL_PERSONAS,
  CouncilPersonaRegistry,
  createCouncilPersonaRegistry,
  DEFAULT_COUNCIL_PERSONA_REGISTRY,
} from '../../src/execution/council-personas.js';

describe('CouncilPersonaRegistry', () => {
  it('ships frozen provider-neutral personas with expected defaults', () => {
    expect(BUILTIN_COUNCIL_PERSONAS.map((persona) => persona.id)).toEqual([
      'executor',
      'skeptic',
      'auditor',
      'security',
      'maintainer',
      'user-advocate',
    ]);
    expect(DEFAULT_COUNCIL_PERSONA_REGISTRY.require('skeptic').defaultVeto).toBe(true);
    expect(DEFAULT_COUNCIL_PERSONA_REGISTRY.require('executor').instruction).not.toMatch(
      /openai|anthropic|deepseek/i,
    );
    expect(Object.isFrozen(BUILTIN_COUNCIL_PERSONAS)).toBe(true);
    expect(Object.isFrozen(BUILTIN_COUNCIL_PERSONAS[0])).toBe(true);
  });

  it('normalizes, deduplicates, and freezes custom persona data', () => {
    const registry = new CouncilPersonaRegistry([
      {
        id: ' domain-expert ',
        name: ' Domain Expert ',
        description: ' Applies domain evidence. ',
        instruction: ' Check the domain assumptions. ',
        defaultWeight: 2,
        tags: [' domain ', 'domain', ' evidence '],
      },
    ]);
    const persona = registry.require('domain-expert');

    expect(persona).toMatchObject({
      id: 'domain-expert',
      name: 'Domain Expert',
      description: 'Applies domain evidence.',
      instruction: 'Check the domain assumptions.',
      defaultWeight: 2,
      tags: ['domain', 'evidence'],
    });
    expect(Object.isFrozen(persona)).toBe(true);
    expect(Object.isFrozen(persona.tags)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it('extends the default registry without mutating it', () => {
    const extended = createCouncilPersonaRegistry([
      {
        id: 'domain-expert',
        name: 'Domain Expert',
        description: 'Applies domain evidence.',
        instruction: 'Check domain assumptions.',
      },
    ]);

    expect(extended.has('executor')).toBe(true);
    expect(extended.has('domain-expert')).toBe(true);
    expect(DEFAULT_COUNCIL_PERSONA_REGISTRY.has('domain-expert')).toBe(false);
  });

  it('supports copy-on-write replacement', () => {
    const replaced = DEFAULT_COUNCIL_PERSONA_REGISTRY.with(
      {
        id: 'executor',
        name: 'Pragmatist',
        description: 'Checks feasibility.',
        instruction: 'Prefer feasible evidence-backed action.',
      },
      { replace: true },
    );

    expect(replaced.require('executor').name).toBe('Pragmatist');
    expect(DEFAULT_COUNCIL_PERSONA_REGISTRY.require('executor').name).toBe('Executor');
  });

  it.each([
    [
      [{ id: 'Bad Id', name: 'Bad', description: 'Bad.', instruction: 'Bad.' }],
      /invalid persona id/,
    ],
    [[{ id: 'empty-name', name: '', description: 'Bad.', instruction: 'Bad.' }], /requires a name/],
    [
      [{ id: 'empty-description', name: 'Bad', description: '', instruction: 'Bad.' }],
      /requires a description/,
    ],
    [
      [{ id: 'empty-instruction', name: 'Bad', description: 'Bad.', instruction: '' }],
      /requires an instruction/,
    ],
    [
      [
        {
          id: 'bad-weight',
          name: 'Bad',
          description: 'Bad.',
          instruction: 'Bad.',
          defaultWeight: 0,
        },
      ],
      /invalid default weight/,
    ],
  ] as const)('rejects malformed persona definitions', (personas, expected) => {
    expect(() => new CouncilPersonaRegistry(personas)).toThrow(expected);
  });

  it('rejects duplicate registration and unknown lookup', () => {
    const persona = {
      id: 'same',
      name: 'Same',
      description: 'Same.',
      instruction: 'Same.',
    };
    expect(() => new CouncilPersonaRegistry([persona, persona])).toThrow(/duplicate persona id/);
    expect(() => DEFAULT_COUNCIL_PERSONA_REGISTRY.require('missing')).toThrow(/unknown persona/);
    expect(() => DEFAULT_COUNCIL_PERSONA_REGISTRY.with(BUILTIN_COUNCIL_PERSONAS[0]!)).toThrow(
      /already exists/,
    );
  });
});

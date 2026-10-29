import { expect, it } from 'vitest';
import { contextModes, modeDraft, modePayload } from '../src/context-modes-model';

const listed = {
  activeId: 'focus',
  modes: [
    {
      id: 'balanced',
      name: 'Balanced',
      description: 'Default',
      isActive: false,
      thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
      preserveK: 10,
      eliseThreshold: 2000,
    },
    {
      id: 'focus',
      name: 'Focus',
      description: '',
      isActive: true,
      custom: true,
      thresholds: { warn: 0.5, soft: 0.6, hard: 0.8 },
      preserveK: 4,
      eliseThreshold: 1000,
    },
    { name: 'no id' },
  ],
};

it('reads listed modes and turns a custom one into an editable draft and back', () => {
  const modes = contextModes(listed);
  expect(modes.map((mode) => [mode.id, mode.active, mode.custom])).toEqual([
    ['balanced', false, false],
    ['focus', true, true],
  ]);
  const draft = modeDraft(modes[1]);
  expect(draft).toMatchObject({ warn: '50', soft: '60', hard: '80', preserveK: '4' });
  expect(modePayload(draft)).toEqual({
    id: 'focus',
    name: 'Focus',
    description: '',
    thresholds: { warn: 0.5, soft: 0.6, hard: 0.8 },
    preserveK: 4,
    eliseThreshold: 1000,
  });
});

it('explains values the engine would refuse', () => {
  const base = { ...modeDraft(), id: 'mine', name: 'Mine' };
  expect(() => modePayload({ ...base, id: 'has space' })).toThrow('mode ID');
  expect(() => modePayload({ ...base, name: ' ' })).toThrow('name');
  expect(() => modePayload({ ...base, warn: '80', soft: '70' })).toThrow('rise');
  expect(() => modePayload({ ...base, hard: '120' })).toThrow('percentage');
  expect(() => modePayload({ ...base, preserveK: '2.5' })).toThrow('whole number');
  expect(modePayload(base).thresholds).toEqual({ warn: 0.6, soft: 0.75, hard: 0.9 });
});

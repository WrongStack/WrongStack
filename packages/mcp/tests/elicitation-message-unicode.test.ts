import { expect, it } from 'vitest';
import { parseElicitationParams, parseUrlElicitation } from '../src/elicitation.js';

const hasLoneSurrogate = (value: string): boolean =>
  [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character));

it('keeps URL and form elicitation messages Unicode-well-formed', () => {
  const message = `${'a'.repeat(3999)}😀tail`;
  const url = parseUrlElicitation({
    mode: 'url',
    message,
    url: 'https://example.test',
    elicitationId: 'id',
  });
  const form = parseElicitationParams({
    message,
    requestedSchema: { type: 'object', properties: {} },
  });
  expect(url.ok && hasLoneSurrogate(url.value.message)).toBe(false);
  expect(form.ok && hasLoneSurrogate(form.value.message)).toBe(false);
});

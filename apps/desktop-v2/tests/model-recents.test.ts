import { expect, it } from 'vitest';
import { MAX_RECENT_MODELS, readRecentModels, withRecentModel } from '../src/model-recents';

it('keeps the chosen model first without duplicates and bounded', () => {
  let list = withRecentModel([], { provider: 'a', model: 'm1' });
  list = withRecentModel(list, { provider: 'b', model: 'm2' });
  list = withRecentModel(list, { provider: 'a', model: 'm1' });
  expect(list).toEqual([
    { provider: 'a', model: 'm1' },
    { provider: 'b', model: 'm2' },
  ]);
  for (let index = 0; index < 10; index++)
    list = withRecentModel(list, { provider: 'p', model: `x${index}` });
  expect(list).toHaveLength(MAX_RECENT_MODELS);
  expect(list[0]).toEqual({ provider: 'p', model: 'x9' });
});
it('reads saved recents defensively', () => {
  expect(
    readRecentModels(() =>
      JSON.stringify([{ provider: 'a', model: 'm', extra: 1 }, { provider: '', model: 'x' }, 7]),
    ),
  ).toEqual([{ provider: 'a', model: 'm' }]);
  expect(readRecentModels(() => null)).toEqual([]);
  expect(readRecentModels(() => '{not json')).toEqual([]);
  expect(
    readRecentModels(() => {
      throw Error('blocked');
    }),
  ).toEqual([]);
});

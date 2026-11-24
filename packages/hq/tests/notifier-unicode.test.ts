import { expect, it } from 'vitest';
import { HqNotifier } from '../src/notifier.js';

it('keeps outbound notification summaries Unicode-well-formed', async () => {
  const sent: RequestInit[] = [];
  const notifier = new HqNotifier('.', {
    fetch: async (_url, init) => {
      sent.push(init);
      return { ok: true, status: 200 };
    },
  });
  (notifier as unknown as { config: unknown }).config = {
    version: 1,
    updatedAt: 'fixed',
    channels: [
      {
        id: 'test',
        name: 'test',
        type: 'webhook',
        url: 'https://example.test/hook',
        enabled: true,
        kinds: ['alert'],
        minSeverity: 'info',
      },
    ],
  };
  notifier.notify({
    kind: 'alert',
    severity: 'error',
    title: `${'a'.repeat(198)}😀tail`,
    body: 'body',
    dedupeKey: 'unicode',
  });
  await notifier.drain();
  const title = JSON.parse(String(sent[0]?.body ?? '{}')).title as string;
  expect(
    [...title].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)),
  ).toBe(false);
});

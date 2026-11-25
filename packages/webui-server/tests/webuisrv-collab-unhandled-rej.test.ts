import { describe, expect, it } from 'vitest';
import { CollabDispatcher } from '../src/server/collab/dispatcher.js';

describe('CollabDispatcher async rejection guard (F2281)', () => {
  it('swallows async feature.handle rejections without emitting unhandledRejection', async () => {
    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.on('unhandledRejection', onUnhandled);

    const dispatcher = new CollabDispatcher([
      {
        type: 'collab.join',
        handle: () => Promise.reject(new Error('boom')) as unknown as void,
      },
    ]);
    expect(dispatcher.dispatch({} as never, {} as never, { type: 'collab.join' })).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toBe(false);
  });
});

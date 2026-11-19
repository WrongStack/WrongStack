// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createTestState } from './helpers/create-test-state.js';
import { key, makeHandler } from './helpers/key-handler-fixture.js';

/**
 * A paste must reach the overlay that owns the keyboard. The paste pipeline
 * runs before picker dispatch, so it used to commit every assembled payload
 * straight into the composer: an API key pasted into the /auth prompt landed
 * in the chat input and the prompt stayed empty.
 */
describe('paste routing with an open picker', () => {
  it('hands an explicit paste to the open picker instead of the composer', async () => {
    const tryPickerKey = vi.fn(() => true);
    const h = makeHandler(createTestState(), undefined, { tryPickerKey });

    await h.handler('sk-abc', key({ paste: true }));

    expect(tryPickerKey).toHaveBeenCalledWith(
      'sk-abc',
      expect.objectContaining({ paste: true }),
      false,
    );
    expect(h.commitPaste).not.toHaveBeenCalled();
  });

  it('hands a marker-delimited paste to the open picker once, markers stripped', async () => {
    const tryPickerKey = vi.fn(() => true);
    const h = makeHandler(createTestState(), undefined, { tryPickerKey });

    await h.handler('\x1b[200~', key());
    await h.handler('sk-abc', key());
    await h.handler('\x1b[201~', key());

    expect(tryPickerKey).toHaveBeenCalledTimes(1);
    expect(tryPickerKey).toHaveBeenCalledWith(
      'sk-abc',
      expect.objectContaining({ paste: true }),
      false,
    );
    expect(h.commitPaste).not.toHaveBeenCalled();
  });

  it('still commits to the composer when no picker takes the paste', async () => {
    const tryPickerKey = vi.fn(() => false);
    const h = makeHandler(createTestState(), undefined, { tryPickerKey });

    await h.handler('hello', key({ paste: true }));

    expect(h.commitPaste).toHaveBeenCalledWith('hello');
  });
});

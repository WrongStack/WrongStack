import assert from 'node:assert/strict';

/** Search retained conversation messages, including rows outside the virtual viewport. */
export async function findConversationMessages(page, query, expectedMessages) {
  await page.keyboard.press('Control+f');
  const input = page.locator('input[data-find-input="conversation"]');
  await input.waitFor();
  await input.fill(query);
  const bar = page.locator('.editor-find-bar').filter({ has: input });
  const status = bar.getByRole('status');
  await page.waitForFunction(
    ({ query, expectedMessages }) => {
      const input = document.querySelector('input[data-find-input="conversation"]');
      const status = input?.closest('section')?.querySelector('[role="status"]')?.textContent ?? '';
      if (input?.value !== query) return false;
      return expectedMessages === 0
        ? /^0 matches in 0 messages/.test(status)
        : new RegExp(' in ' + expectedMessages + ' messages?(?:$| \\u00b7)').test(status);
    },
    { query, expectedMessages },
  );
  assert.match(await status.innerText(), new RegExp(' in ' + expectedMessages + ' messages?'));
  const messageIds = [];
  for (let index = 0; index < expectedMessages; index++) {
    await input.press('Enter');
    const previous = messageIds.at(-1) ?? null;
    try {
      await page.waitForFunction((previous) => {
        const current = document.querySelector('.chat-message.find-current');
        return current && current.getAttribute('data-message-id') !== previous;
      }, previous);
    } catch (error) {
      console.log(
        'FIND_DIAGNOSTIC ' +
          JSON.stringify(
            await page.evaluate(() => {
              const pane = document.querySelector('.native-chat-messages');
              return {
                top: pane?.scrollTop,
                height: pane?.scrollHeight,
                view: pane?.clientHeight,
                status: document.querySelector('.editor-find-count')?.textContent,
                rows: [...(pane?.querySelectorAll('.chat-message') ?? [])].map((row) => ({
                  id: row.getAttribute('data-message-id'),
                  className: row.className,
                  top: row.getBoundingClientRect().top,
                  height: row.getBoundingClientRect().height,
                  text: row.textContent?.slice(0, 100),
                  parentStyle: row.parentElement?.getAttribute('style'),
                })),
              };
            }),
          ),
      );
      throw error;
    }
    const current = page.locator('.chat-message.find-current');
    await current.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const row = document.querySelector('.chat-message.find-current');
      const pane = document.querySelector('.native-chat-messages');
      if (!row || !pane) return false;
      const bounds = row.getBoundingClientRect(),
        view = pane.getBoundingClientRect();
      return bounds.bottom > view.top && bounds.top < view.bottom;
    });
    const id = await current.getAttribute('data-message-id');
    assert.ok(id, 'Each search result identifies a retained message');
    assert.ok(!messageIds.includes(id), 'Search reaches distinct retained messages');
    messageIds.push(id);
  }
  await input.press('Escape');
  await input.waitFor({ state: 'detached' });
  return messageIds;
}

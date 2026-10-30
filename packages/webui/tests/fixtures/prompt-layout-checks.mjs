import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';

const labels = {
  en: {
    search: 'Search prompts…',
    add: '＋ New prompt',
    variable: '＋ var',
    name: 'name',
    remove: 'Remove variable',
    favorite: 'Toggle favorite',
    save: 'Save prompt',
    title: 'Title *',
    content: 'Prompt content * — use {{name}} for variables',
    back: 'Back',
    level: 'Detail level',
    insert: 'Insert into chat',
  },
  tr: {
    search: 'Promptları ara…',
    add: '＋ Yeni prompt',
    variable: '＋ değişken',
    name: 'ad',
    remove: 'Değişkeni kaldır',
    favorite: 'Favori değiştir',
    save: 'Promptu kaydet',
    title: 'Başlık *',
    content: 'Prompt içeriği * — değişkenler için {{name}} kullanın',
    back: 'Geri',
    level: 'Detay seviyesi',
    insert: 'Sohbete ekle',
  },
};

export async function checkPromptLayout(browser, base, output, errors) {
  const results = [];
  const failures = [];
  for (const theme of ['light', 'dark']) {
    for (const lang of ['en', 'tr']) {
      for (const width of [1440, 390, 320]) {
        const page = await browser.newPage({
          viewport: { width, height: 640 },
          colorScheme: theme,
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const check = async (name, run) => {
          try {
            await run();
            results.push({ theme, lang, width, name, result: 'PASS' });
          } catch (error) {
            failures.push(`${theme}/${lang}/${width}/${name}: ${error.message}`);
          }
        };
        const fit = async (element, what) => {
          const size = await element.evaluate((el) => ({
            width: el.clientWidth,
            content: el.scrollWidth,
          }));
          assert(
            size.content <= size.width + 1,
            `EXPECTED ${what} to fit; ACTUAL ${JSON.stringify(size)}`,
          );
        };
        const l = labels[lang];
        try {
          await page.goto(`${base}?prompt-review=1&theme=${theme}&lang=${lang}`);
          await page.getByRole('button', { name: 'Open prompt library' }).click();
          const dialog = page.getByRole('dialog');
          await expect(dialog.getByRole('textbox', { name: l.search })).toBeFocused();
          await page.evaluate(() => document.fonts.ready);
          const control = dialog.getByRole('button', { name: /Review workspace/ });
          await check('short list control', () => fit(control, 'short list item'));
          await check('long list item', () =>
            fit(
              dialog.getByRole('button', { name: /Workspace_review_evidence/ }),
              'long list item',
            ),
          );
          await control.click();
          await check('preview control', async () => {
            await expect(
              dialog.getByText('Review {{workspace}} and report the result.', { exact: true }),
            ).toBeVisible();
            await fit(dialog, 'dialog');
          });
          await check('favorite toggles in preview', async () => {
            const star = dialog.getByTitle(l.favorite);
            await expect(star).toHaveText('☆');
            await star.click();
            await expect(star).toHaveText('★', { timeout: 1000 });
            await star.click();
            await expect(star).toHaveText('☆');
          });
          if (width < 640) await dialog.getByRole('button', { name: l.back, exact: true }).click();
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `prompts-list-${theme}-${lang}-${width}.png`),
          });
          await dialog.getByRole('button', { name: l.add }).click();
          await check('empty form control', () =>
            fit(dialog.getByRole('textbox', { name: l.title }), 'title field'),
          );
          await dialog.getByRole('textbox', { name: l.title }).fill('Workspace template');
          await dialog.getByRole('textbox', { name: l.content }).fill('Review {{workspace}}.');
          await dialog.getByRole('button', { name: l.variable, exact: true }).click();
          await check('variable editor fits', async () => {
            const row = dialog.getByRole('textbox', { name: l.name, exact: true }).locator('../..');
            await fit(row, 'variable row');
          });
          await check('variable name retains keyboard focus', async () => {
            const name = dialog.getByRole('textbox', { name: l.name, exact: true });
            await name.pressSequentially('workspace');
            assert.equal(
              await name.inputValue(),
              'workspace',
              'EXPECTED complete typed variable name',
            );
            await expect(name).toBeFocused();
          });
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `prompts-create-${theme}-${lang}-${width}.png`),
          });
          await check('save remains reachable', async () => {
            const save = dialog.getByRole('button', { name: l.save });
            await expect(save).toBeEnabled();
            const reachable = await save.evaluate((el) => {
              const box = el.getBoundingClientRect();
              return el.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
              );
            });
            assert(reachable, 'EXPECTED Save prompt reachable without horizontal scrolling');
          });
          await check('removing a variable preserves the remaining row', async () => {
            await dialog.getByRole('button', { name: l.variable, exact: true }).click();
            const names = dialog.getByRole('textbox', { name: l.name, exact: true });
            await names.nth(1).fill('artifact');
            await dialog.getByTitle(l.remove).nth(1).click();
            await expect(names).toHaveCount(1);
            await expect(names).toHaveValue('workspace');
          });
          await check('save submits only public variable fields', async () => {
            await dialog.getByRole('button', { name: l.save }).click();
            await expect(dialog.getByRole('button', { name: /Review workspace/ })).toBeVisible();
            const payload = await page.evaluate(
              () => window.fixture.promptMessages.find((m) => m.type === 'prompts.create')?.payload,
            );
            assert.equal(payload.title, 'Workspace template');
            assert.deepEqual(payload.variables, [{ name: 'workspace', required: true }]);
          });
          await dialog.getByRole('button', { name: /Workspace_review_evidence/ }).click();
          await check('long preview fits', async () => {
            await expect(
              dialog.getByText('Review {{workspace}} and report the result.', { exact: true }),
            ).toBeVisible();
            await fit(dialog, 'long preview');
            await fit(
              dialog.getByText('Workspace_review_evidence_'.repeat(6), { exact: true }).last(),
              'preview title',
            );
          });
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `prompts-preview-${theme}-${lang}-${width}.png`),
          });
          await check('favorite preserves filled variables and insertion', async () => {
            const variable = dialog.getByRole('textbox', { name: 'workspace', exact: false });
            await variable.fill('WrongStack');
            await dialog.getByRole('combobox', { name: l.level }).selectOption('advanced');
            const star = dialog.getByTitle(l.favorite);
            await star.click();
            await expect(star).toHaveText('★');
            await expect(variable).toHaveValue('WrongStack');
            await expect(dialog.getByRole('combobox', { name: l.level })).toHaveValue('advanced');
            await dialog.getByRole('button', { name: l.insert, exact: true }).click();
            await expect(dialog).toHaveCount(0);
            assert.equal(
              await page.evaluate(() => window.fixture.ui.getState().promptInsertRequest),
              'Review WrongStack and record reproducible evidence.',
            );
          });
          await page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);
        } finally {
          await page.close();
        }
      }
    }
  }
  console.log(`PROMPT CHECKS: ${results.length} passed`);
  if (failures.length) console.error(failures.join('\n'));
  assert.deepEqual(failures, [], 'PROBLEM CONFIRMED: prompt library defects');
  console.log('PROBLEM NOT REPRODUCED; FIX VERIFIED');
  return results;
}

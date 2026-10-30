// Real production components + compiled theme CSS. Only the transport is stubbed;
// this checks layout, motion, keyboard interaction and navigation, not a model run.
// Run: bun packages/webui/tests/workbench-visual-browser-smoke.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { checkComposerLayout } from './fixtures/composer-layout-checks.mjs';
import { checkHistoryLayout } from './fixtures/history-layout-checks.mjs';
import { checkInspectionLayout } from './fixtures/inspection-layout-checks.mjs';
import { checkNavigationLayout } from './fixtures/navigation-layout-checks.mjs';
import { checkNextSteps } from './fixtures/next-steps-checks.mjs';
import { checkOverlayLayout } from './fixtures/overlay-layout-checks.mjs';
import { checkPromptLayout } from './fixtures/prompt-layout-checks.mjs';
import { checkProviderBrands } from './fixtures/provider-brand-checks.mjs';
import { checkResponsiveLayout } from './fixtures/responsive-layout-checks.mjs';
import { assertSquareCorners } from './fixtures/square-corner-check.mjs';
import { checkWorkbenchInteractions } from './fixtures/workbench-interaction-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, '../../.temp_files/webui-workbench-visual');
const requestedViews = process.env.WEBUI_VISUAL_VIEWS?.split(',').filter(Boolean);
const interactionsOnly = process.env.WEBUI_VISUAL_INTERACTIONS_ONLY === '1';
const providersOnly = process.env.WEBUI_VISUAL_PROVIDERS_ONLY === '1';
const composerOnly = process.env.WEBUI_VISUAL_COMPOSER_ONLY === '1';
const nextStepsOnly = process.env.WEBUI_VISUAL_NEXT_STEPS_ONLY === '1';
const responsiveOnly = process.env.WEBUI_VISUAL_RESPONSIVE_ONLY === '1';
const overlaysOnly = process.env.WEBUI_VISUAL_OVERLAYS_ONLY === '1';
const navigationOnly = process.env.WEBUI_VISUAL_NAVIGATION_ONLY === '1';
const promptsOnly = process.env.WEBUI_VISUAL_PROMPTS_ONLY === '1';
const historyOnly = process.env.WEBUI_VISUAL_HISTORY_ONLY === '1';
const inspectionOnly = process.env.WEBUI_VISUAL_INSPECTION_ONLY === '1';
const skipGeneral =
  interactionsOnly ||
  providersOnly ||
  composerOnly ||
  nextStepsOnly ||
  responsiveOnly ||
  overlaysOnly ||
  navigationOnly ||
  promptsOnly ||
  historyOnly ||
  inspectionOnly;
const virtualId = 'virtual:workbench-visual-smoke';
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import { i18n } from '/src/i18n/index.ts';
import { ThemeProvider } from '/src/components/ThemeProvider.tsx';
import { ActivityBar } from '/src/components/activity-bar/index.tsx';
import { WorkbenchTopbar } from '/src/components/WorkbenchTopbar.tsx';
import { WelcomeScreen } from '/src/components/WelcomeScreen.tsx';
import { ViewRouter } from '/src/components/ViewRouter.tsx';
import { VIEW_REGISTRY } from '/src/components/view-registry.ts';
import { seedWorkbenchVisualData } from '/tests/fixtures/workbench-visual.ts';
import { InteractionWorkbench, seedInteractionWorkbench } from '/tests/fixtures/InteractionWorkbench.tsx';
import { ProviderBrandWorkbench } from '/tests/fixtures/ProviderBrandWorkbench.tsx';
import { NextStepsWorkbench, seedNextStepsWorkbench } from '/tests/fixtures/NextStepsWorkbench.tsx';
import { OverlayReviewWorkbench, seedOverlayReview } from '/tests/fixtures/OverlayReviewWorkbench.tsx';
import { NavigationReviewWorkbench, seedNavigationReview } from '/tests/fixtures/NavigationReviewWorkbench.tsx';
import { PromptReviewWorkbench, seedPromptReview } from '/tests/fixtures/PromptReviewWorkbench.tsx';
import { HistoryReviewWorkbench, seedHistoryReview } from '/tests/fixtures/HistoryReviewWorkbench.tsx';
import { InspectionReviewWorkbench, seedInspectionReview } from '/tests/fixtures/InspectionReviewWorkbench.tsx';
import { ChatInput } from '/src/components/ChatInput.tsx';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from '/src/components/ui/dialog.tsx';
import { Button } from '/src/components/ui/button.tsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '/src/components/ui/tabs.tsx';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '/src/components/ui/dropdown-menu.tsx';
import { PanelSuspense } from '/src/components/PanelSuspense.tsx';
import { useChatStore, useConfigStore, useSessionStore, useUIStore } from '/src/stores/index.ts';
import { useLocalPrefs } from '/src/stores/local-prefs.ts';
import { getWSClient } from '/src/lib/ws-client.ts';
await i18n.changeLanguage(new URLSearchParams(location.search).get('lang') || 'en');
await i18n.loadNamespaces(['activity', 'common', 'setup', 'chat', 'settings']);
const client = getWSClient();
const sent = [];
client.send = (message) => { sent.push(message); return true; };
client.listSavedProviders = () => {};
useConfigStore.setState({ provider: 'WrongForge', model: 'workspace-model', wsConnected: true, wsStatus: { state: 'open' } });
useSessionStore.getState().setEnv({ projectName: 'WrongStack', cwd: 'D:/Codebox/PROJECTS/WrongStack' });
useLocalPrefs.getState().set({ chromeLevel: 'calm' });
const params = new URLSearchParams(location.search);
if (params.has('composer') || params.has('nextsteps')) Object.defineProperty(client, 'isConnected', { get: () => useConfigStore.getState().wsConnected });
if (params.has('interactions')) seedInteractionWorkbench();
if (params.has('nextsteps')) seedNextStepsWorkbench();
if (params.has('overlay-review')) seedOverlayReview();
if (params.has('navigation-review')) seedNavigationReview();
const promptReview = params.has('prompt-review') ? seedPromptReview() : {};
const historyReview = params.has('history-review') ? seedHistoryReview() : {};
if (params.has('inspection-review')) seedInspectionReview();
useUIStore.setState({ currentView: params.get('view') || 'chat', sidebarOpen: false });
window.fixture = { ui: useUIStore, prefs: useLocalPrefs, config: useConfigStore, chat: useChatStore, sent, ...promptReview, ...historyReview, views: ['chat', ...Object.keys(VIEW_REGISTRY)], ...(params.has('dense') ? seedWorkbenchVisualData() : {}) };
const theme = params.get('theme') || 'dark';
function Fixture() {
  const currentView = useUIStore(s => s.currentView);
  return <ThemeProvider defaultTheme={theme} storageKey="visual-smoke-theme">
    <div className="ws-app-root flex min-h-0 min-w-0 overflow-hidden">
      <ActivityBar />
      <main id="main-content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <WorkbenchTopbar currentView={currentView} projectName="WrongStack" isLoading={false} iteration={null} onPalette={() => {}} onSettings={() => useUIStore.getState().setCurrentView('settings')} />
        {params.has('inspection-review') ? <InspectionReviewWorkbench /> : params.has('history-review') ? <HistoryReviewWorkbench /> : params.has('prompt-review') ? <PromptReviewWorkbench /> : params.has('navigation-review') && !params.has('views') ? <NavigationReviewWorkbench /> : params.has('overlay-review') && !params.has('views') ? <OverlayReviewWorkbench /> : params.has('nextsteps') ? <NextStepsWorkbench /> : params.has('provider-brands') ? <ProviderBrandWorkbench /> : params.has('interactions') ? <InteractionWorkbench /> : params.has('views') ? <div className="relative flex min-h-0 min-w-0 flex-1 flex-col"><ViewRouter sessionId={null} /></div> : <>
        <div className="ws-chat-surface mx-3 mt-3 flex-1 min-h-0 overflow-auto border border-border">
          <WelcomeScreen />
          <div className="mx-auto flex max-w-4xl flex-wrap gap-3 px-6 pb-6" data-testid="primitives">
            <Dialog><DialogTrigger asChild><Button>Preview dialog</Button></DialogTrigger>
              <DialogContent><DialogTitle>Workspace preview</DialogTitle><DialogDescription>Keyboard focus and theme preview.</DialogDescription>
                <Tabs defaultValue="first"><TabsList><TabsTrigger value="first">Overview</TabsTrigger><TabsTrigger value="second">Activity</TabsTrigger></TabsList><TabsContent value="first">Overview content</TabsContent><TabsContent value="second">Activity content</TabsContent></Tabs>
              </DialogContent>
            </Dialog>
            <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline">Preview menu</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Menu action</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            <PanelSuspense label="Loading preview" />
          </div>
        </div>
        <div className="shrink-0 p-3"><ChatInput /></div></>}
      </main>
    </div>
  </ThemeProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'workbench-visual-smoke',
      resolveId: (id) => (id === virtualId ? `\0${virtualId}.tsx` : undefined),
      load: (id) =>
        id === `\0${virtualId}.tsx`
          ? new Bun.Transpiler({
              loader: 'tsx',
              tsconfig: { compilerOptions: { jsx: 'react' } },
            }).transformSync(source)
          : undefined,
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] !== '/__workbench_visual') return next();
          const html = await vite.transformIndexHtml(
            req.url,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/${virtualId}"></script></body></html>`,
          );
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        });
      },
    },
  ],
});

let browser;
const errors = [];
const results = [];
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  browser = await chromium.launch({ headless: true });
  for (const theme of skipGeneral ? [] : ['light', 'dark']) {
    for (const width of [1440, 768, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 980 }, colorScheme: theme });
      page.on('pageerror', (error) => {
        errors.push(error.message);
        console.error('Browser error:', error.message);
      });
      await page.goto(`http://127.0.0.1:${address.port}/__workbench_visual?theme=${theme}`);
      await expect(page.locator('.ws-welcome h2')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect
        .poll(() => page.locator('.ws-welcome-hero').evaluate((el) => getComputedStyle(el).opacity))
        .toBe('1');
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Page overflows horizontally',
      );
      const shortcuts = page.locator('.ws-welcome-shortcuts button');
      await shortcuts.nth(0).click();
      assert.equal(await page.evaluate(() => window.fixture.ui.getState().currentView), 'files');
      await shortcuts.nth(1).click();
      assert.equal(
        await page.evaluate(() => window.fixture.ui.getState().activeActivity),
        'skills',
      );
      await shortcuts.nth(2).click();
      assert.equal(await page.evaluate(() => window.fixture.ui.getState().currentView), 'settings');
      await page.getByTestId('welcome-launcher-bug').click();
      await expect(page.locator('#bug-hunt-mode')).toBeVisible();
      await expect(page.locator('#bug-hunt-scope')).toBeVisible();
      await page.getByTestId('welcome-launcher-perf').click();
      await expect(page.locator('#perf-mode')).toBeVisible();
      await expect(page.locator('#bug-hunt-scope')).toHaveCount(0);
      assert(
        await page.locator('.ws-welcome').evaluate((el) => el.scrollWidth <= el.clientWidth),
        'Welcome content overflows',
      );
      await page.getByRole('button', { name: 'Preview dialog', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      const box = await dialog.boundingBox();
      await assertSquareCorners(page);
      await page.screenshot({
        animations: 'disabled',
        path: path.join(output, `dialog-${theme}-${width}.png`),
      });
      assert(box && box.x >= 0 && box.x + box.width <= width + 1, 'Dialog leaves viewport');
      assert(
        Math.abs(box.x + box.width / 2 - width / 2) < 2,
        `Dialog is not centered: ${JSON.stringify({ box, width, style: await dialog.evaluate((el) => ({ transform: getComputedStyle(el).transform, translate: getComputedStyle(el).translate, scale: getComputedStyle(el).scale, left: getComputedStyle(el).left })) })}`,
      );
      await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      await expect(page.getByRole('tabpanel')).toHaveText('Activity content');
      await page.keyboard.press('Escape');
      console.log('dialog and tabs passed', theme, width);
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Preview dialog', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Preview menu', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Menu action' })).toBeVisible();
      await assertSquareCorners(page);
      await page.keyboard.press('Escape');
      console.log('menu passed', theme, width);
      await expect(page.getByRole('menu')).toHaveCount(0);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(
        await page.locator('.ws-art-orbit').evaluate((el) => getComputedStyle(el).animationName),
        'none',
      );
      assert.equal(
        await page
          .locator('.ws-welcome-shortcut')
          .first()
          .evaluate((el) => getComputedStyle(el).transitionDuration),
        '0s',
      );
      await page.getByRole('button', { name: 'Preview dialog', exact: true }).click();
      assert.equal(await dialog.evaluate((el) => getComputedStyle(el).animationName), 'none');
      const reducedBox = await dialog.boundingBox();
      assert(
        reducedBox && Math.abs(reducedBox.x + reducedBox.width / 2 - width / 2) < 2,
        'Reduced motion breaks dialog centering',
      );
      await page.keyboard.press('Escape');
      await page.evaluate(() =>
        window.fixture.ui.setState({ currentView: 'chat', sidebarOpen: false }),
      );
      await page.getByTestId('welcome-launcher-perf').click();
      await page.locator('.ws-chat-surface').evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.getByTestId('primitives').evaluate((el) => {
        el.style.display = 'none';
      });
      await page.screenshot({
        animations: 'disabled',
        path: path.join(output, `${theme}-${width}.png`),
      });
      results.push({
        theme,
        width,
        layout: 'PASS',
        navigation: 'PASS',
        launchers: 'PASS',
        dialog: 'PASS',
        menu: 'PASS',
        reducedMotion: 'PASS',
      });
      await page.close();
    }
  }
  const routed = [];
  for (const theme of skipGeneral ? [] : ['dark', 'light']) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 980 }, colorScheme: theme });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/__workbench_visual?theme=${theme}&views=1`);
      await expect(page.locator('.ws-welcome h2')).toBeVisible();
      const views = requestedViews ?? (await page.evaluate(() => window.fixture.views));
      for (const view of views) {
        await page.goto(
          `http://127.0.0.1:${address.port}/__workbench_visual?theme=${theme}&views=1&view=${view}`,
        );
        await expect(page.locator('.ws-activity-rail')).toBeVisible();
        if (view === 'chat') await expect(page.locator('.ws-welcome h2')).toBeVisible();
        else await expect(page.locator(`[data-workbench-view="${view}"]`)).toBeVisible();
        await expect(page.locator('.ws-loading-art')).toHaveCount(0, { timeout: 15000 });
        if (view === 'chat') {
          await page.evaluate(() => window.fixture.ui.setState({ currentView: 'files' }));
          assert.equal(
            await page
              .locator('.ws-art-orbit')
              .evaluate((el) => getComputedStyle(el).animationPlayState),
            'paused',
          );
          await page.evaluate(() => window.fixture.ui.setState({ currentView: 'chat' }));
        }
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${view} page overflows at ${width}`,
        );
        await page.evaluate(() => document.fonts.ready);
        if (view === 'codemap' && width < 1200) {
          const canvas = page.locator('.ws-code-canvas');
          assert(
            await canvas.evaluate((el) => el.clientWidth > 250 && el.clientHeight >= 400),
            'Code Atlas canvas must retain usable dimensions on mobile',
          );
          await canvas.scrollIntoViewIfNeeded();
        }
        const motif = page.locator('.ws-motif-points').first();
        if (await motif.count()) {
          await page.emulateMedia({ reducedMotion: 'reduce' });
          assert.equal(await motif.evaluate((el) => getComputedStyle(el).animationName), 'none');
          await page.emulateMedia({ reducedMotion: 'no-preference' });
        }
        await expect(
          page.locator('[role="alert"]').filter({ hasText: /hit an error|Something went wrong/i }),
        ).toHaveCount(0);
        await page.screenshot({
          animations: 'disabled',
          path: path.join(output, `view-${view}-${width}${theme === 'light' ? '-light' : ''}.png`),
        });
        routed.push({ view, width, theme });
        await assertSquareCorners(page);
        console.log('routed view passed', view, width, theme);
      }
      for (const view of ['kanban', 'roster', 'memory']) {
        if (requestedViews && !requestedViews.includes(view)) continue;
        await page.goto(
          `http://127.0.0.1:${address.port}/__workbench_visual?theme=${theme}&views=1&dense=1&view=${view}`,
        );
        if (view === 'kanban') {
          await expect(
            page.getByRole('button', {
              name: 'Select task: Theme tokens and surfaces',
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.locator('.ws-task-card')).toHaveCount(5);
          const move = page.locator('.ws-task-card select').first();
          await move.selectOption('review');
          assert(
            await page.evaluate(() =>
              window.fixture.sent.some((message) => message.type.includes('move')),
            ),
            'Card move must reach the transport',
          );
        } else if (view === 'roster') {
          await page.getByRole('button', { name: /Design agent/ }).click();
          const detail = page.locator('.ws-live-fleet > div').last();
          assert(
            await detail.evaluate((el) => el.clientWidth > 250 && el.clientHeight > 100),
            'Agent detail must remain usable on mobile',
          );
          await expect(detail.getByText('Design agent', { exact: true })).toBeVisible();
        } else {
          await expect(page.locator('.ws-memory-card')).toHaveCount(3);
          await page.locator('input[aria-label]').first().fill('theme');
          await expect(page.locator('.ws-memory-card')).toHaveCount(1);
          await expect(page.locator('.ws-memory-card')).toContainText('Use semantic theme tokens');
        }
        await page.screenshot({
          animations: 'disabled',
          path: path.join(output, `dense-${view}-${width}-${theme}.png`),
        });
        console.log('populated view passed', view, width, theme);
        await assertSquareCorners(page);
      }
      await page.close();
    }
  }
  const interactions =
    providersOnly ||
    composerOnly ||
    nextStepsOnly ||
    responsiveOnly ||
    overlaysOnly ||
    navigationOnly ||
    promptsOnly ||
    historyOnly ||
    inspectionOnly
      ? []
      : await checkWorkbenchInteractions(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  const providers =
    interactionsOnly ||
    composerOnly ||
    nextStepsOnly ||
    responsiveOnly ||
    overlaysOnly ||
    navigationOnly ||
    promptsOnly ||
    historyOnly ||
    inspectionOnly
      ? []
      : await checkProviderBrands(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  const composer =
    interactionsOnly ||
    providersOnly ||
    nextStepsOnly ||
    responsiveOnly ||
    overlaysOnly ||
    navigationOnly ||
    promptsOnly ||
    historyOnly ||
    inspectionOnly
      ? []
      : await checkComposerLayout(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  const nextSteps =
    interactionsOnly ||
    providersOnly ||
    composerOnly ||
    responsiveOnly ||
    overlaysOnly ||
    navigationOnly ||
    promptsOnly ||
    historyOnly ||
    inspectionOnly
      ? []
      : await checkNextSteps(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  const responsive =
    skipGeneral && !responsiveOnly
      ? []
      : await checkResponsiveLayout(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  assert.deepEqual(errors, [], 'Browser runtime errors');
  const overlays =
    skipGeneral && !overlaysOnly
      ? []
      : await checkOverlayLayout(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  assert.deepEqual(errors, [], 'Browser runtime errors in overlays');
  const navigation =
    skipGeneral && !navigationOnly
      ? []
      : await checkNavigationLayout(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  assert.deepEqual(errors, [], 'Browser runtime errors in navigation');
  const prompts =
    skipGeneral && !promptsOnly
      ? []
      : await checkPromptLayout(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  assert.deepEqual(errors, [], 'Browser runtime errors in prompt library');
  const history =
    skipGeneral && !historyOnly
      ? []
      : await checkHistoryLayout(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  assert.deepEqual(errors, [], 'Browser runtime errors in session history');
  const inspection =
    skipGeneral && !inspectionOnly
      ? []
      : await checkInspectionLayout(
          browser,
          `http://127.0.0.1:${address.port}/__workbench_visual`,
          output,
          errors,
        );
  assert.deepEqual(errors, [], 'Browser runtime errors in inspection and confirmations');
  console.log(
    JSON.stringify(
      {
        results,
        interactions,
        providers,
        composer,
        nextSteps,
        responsive,
        overlays,
        navigation,
        prompts,
        history,
        inspection,
        routedChecks: routed.length,
        registeredViews: [...new Set(routed.map((item) => item.view))],
        errors,
        screenshots: output,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}

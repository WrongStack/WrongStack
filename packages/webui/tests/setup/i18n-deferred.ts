import { beforeAll } from 'vitest';

/**
 * `src/i18n` bundles only the small namespaces inline and fetches `activity`
 * and `settings` as async chunks right after init. A component test that
 * renders on the first tick races that fetch and sees raw keys
 * (`activity:toolGroup.toolCalls`) instead of English — on a loaded CI runner,
 * most of the time.
 *
 * Runs after the test file's imports, so i18next is already initialized
 * exactly when the file loaded the real `@/i18n`; suites that never touch it,
 * or that mock i18next / react-i18next, are left alone.
 */
beforeAll(async () => {
  try {
    const { default: i18n } = await import('i18next');
    if (i18n?.isInitializing && !i18n.isInitialized) {
      await new Promise<void>((resolve) => i18n.once('initialized', () => resolve()));
    }
    if (i18n?.isInitialized && typeof i18n.loadNamespaces === 'function') {
      await i18n.loadNamespaces(['activity', 'settings']);
    }
  } catch {
    // A suite that mocks i18next without a default export: nothing to await.
  }
});

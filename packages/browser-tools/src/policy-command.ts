import { browserInstallationDiagnostics } from './manager.js';
import { browserPrivateOrigins, setBrowserPrivateOrigin } from './policy.js';
import { installBrowserRuntime } from './runtime.js';

export const BROWSER_POLICY_HELP = [
  '/browser                         Show browser setup and allowed private origins',
  '/network                         Alias; origin allowances also cover fetch and read_url_content',
  '/browser install                 Install Chromium now (also automatic on first open)',
  '/browser allow <origin>          Allow an exact origin in this project, immediately',
  '/browser allow loopback          Allow every localhost / 127.0.0.1 / ::1 port in this project',
  '/browser remove <origin>         Remove a project origin allowance (or loopback)',
  'Example: /browser allow http://localhost:3000',
  'Loopback shorthand is supported: /network allow localhost:3000',
  'Origins supplied by WRONGSTACK_BROWSER_PRIVATE_ORIGINS stay managed by the environment.',
].join('\n');

/**
 * The `/browser` (alias `/network`) command body, shared by every surface:
 * the CLI/TUI slash registry and the WebUI's `browser.policy` message run the
 * same parser against the same project policy file.
 */
export async function runBrowserPolicyCommand(root: string, args: string): Promise<string> {
  const [action, origin, ...extra] = args.trim().split(/\s+/);
  try {
    if (!action || action === 'status') {
      const status = await browserInstallationDiagnostics();
      const origins = browserPrivateOrigins(root);
      return `${status.message}\nAllowed private origins: ${origins.join(', ') || '(none)'}\n${BROWSER_POLICY_HELP}`;
    }
    if (action === 'install' && !origin) {
      await installBrowserRuntime();
      return 'Chromium installed and ready.';
    }
    if ((action === 'allow' || action === 'remove') && origin && extra.length === 0) {
      const normalizedOrigin = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/i.test(origin)
        ? `http://${origin}`
        : origin;
      const origins = await setBrowserPrivateOrigin(root, normalizedOrigin, action === 'allow');
      return `Network project policy saved. Allowed private origins: ${origins.join(', ') || '(none)'}.`;
    }
    return BROWSER_POLICY_HELP;
  } catch (error) {
    return `Browser setup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono';
import '@xyflow/react/dist/style.css';
import './index.css';
import './syntax-highlight.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { exchangeBootstrapIfNeeded, scrubTokenFromUrl, upgradeStoredTokenToCookie } from './data/auth/index.js';
import { connectHqDataPlane } from './data/wire.js';
import { AppShell } from './components/hq/app-shell.js';

/**
 * Boot order matters.
 *
 * 1. Consume the one-time `#bootstrap=` code, if the URL carries one. It must
 *    happen before anything opens a socket, because it is what mints this
 *    tab's session cookie.
 * 2. Scrub `?token=` out of the address bar so the credential stops living in
 *    history, screenshots and copied links.
 * 3. Mint a cookie for any stored token — deliberately NOT awaited. It must
 *    not delay first paint, and both orderings are correct: a WS URL built
 *    before the swap still carries a valid token, one built after rides the
 *    cookie.
 * 4. Connect the data plane, then render.
 */
const container = document.getElementById('root');

if (container !== null) {
  void exchangeBootstrapIfNeeded().finally(() => {
    scrubTokenFromUrl();
    void upgradeStoredTokenToCookie();

    connectHqDataPlane();

    createRoot(container).render(
      <StrictMode>
        <AppShell />
      </StrictMode>,
    );
  });
}

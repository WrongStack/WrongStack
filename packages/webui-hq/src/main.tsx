import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono';
import '@xyflow/react/dist/style.css';
import './index.css';
import './syntax-highlight.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  exchangeBootstrapIfNeeded,
  hasAuthenticatedHqBrowserSession,
  scrubTokenFromUrl,
  upgradeStoredTokenToCookie,
} from './data/auth/index.js';
import { useHqStore } from './data/store/index.js';
import { connectHqDataPlane } from './data/wire.js';
import { isHqMobilePath } from './mobile/route.js';

/**
 * Boot order matters.
 *
 * 1. Consume the one-time `#bootstrap=` code, if the URL carries one. It must
 *    happen before anything opens a socket, because it is what mints this
 *    tab's session cookie.
 * 2. Scrub `?token=` out of the address bar so the credential stops living in
 *    history, screenshots and copied links.
 * 3. Mint a cookie for any stored token, then confirm the browser session.
 *    Password-only visitors stop at the gate without generating guaranteed
 *    401 HTTP/WS noise before they have had a chance to authenticate.
 * 4. Connect the data plane only when authenticated, then render the desktop
 *    or independently chunked mobile surface.
 */
const container = document.getElementById('root');
const mobilePath = isHqMobilePath(window.location.pathname);

if (container !== null) {
  void exchangeBootstrapIfNeeded().finally(async () => {
    scrubTokenFromUrl();
    await upgradeStoredTokenToCookie();
    const authenticated = await hasAuthenticatedHqBrowserSession({ passwordOnly: mobilePath });
    if (authenticated) connectHqDataPlane();
    else useHqStore.getState().markAuthRequired();

    const surface = mobilePath
      ? import('./mobile/mobile-app.js').then((module) => module.MobileApp)
      : import('./components/hq/app-shell.js').then((module) => module.AppShell);

    void surface.then((Surface) => {
      createRoot(container).render(
        <StrictMode>
          <Surface />
        </StrictMode>,
      );
    });
  });
}

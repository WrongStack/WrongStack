import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono';
import '@xyflow/react/dist/style.css';
import {
  projectHqAlertMessage,
  projectHqCommandStatusMessage,
  projectHqEventMessage,
  projectHqFleetMessage,
} from '@wrongstack/webui-server/protocol';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { HqApp } from './app.js';
import { scrubTokenFromUrl, exchangeBootstrapIfNeeded } from './lib/auth.js';
import { getHqClient } from './lib/hq-ws-client.js';
import { useHqStore } from './store.js';

const container = document.getElementById('root');
if (container !== null) {
  // Bootstrap exchange: if the URL carries a one-time code in the fragment,
  // exchange it for an HttpOnly session cookie before starting the SPA.
  // The fragment is scrubbed on success and the cookie carries forward on
  // all subsequent HTTP and WebSocket requests.
  void exchangeBootstrapIfNeeded().finally(() => {
    scrubTokenFromUrl();

    const client = getHqClient();
    client.onStateChange((connectionState) => {
      useHqStore.getState()._setConnected(connectionState === 'connected');
    });
    client.on((msg) => {
      if (msg.type === 'hq.snapshot') {
        const projection = projectHqFleetMessage(msg);
        if (projection) useHqStore.getState()._onSnapshot(projection.snapshot);
      } else if (msg.type === 'hq.event') {
        const projection = projectHqEventMessage(msg);
        if (projection) useHqStore.getState()._onEvent(projection.event);
      } else if (msg.type === 'hq.alert') {
        const projection = projectHqAlertMessage(msg);
        if (projection) useHqStore.getState()._onAlert(projection.alert);
      } else if (msg.type === 'hq.command_status') {
        const projection = projectHqCommandStatusMessage(msg);
        if (projection) useHqStore.getState()._onCommandStatus(projection.command);
      }
    });

    const root = createRoot(container);
    root.render(
      <React.StrictMode>
        <HqApp />
      </React.StrictMode>,
    );
  });
}

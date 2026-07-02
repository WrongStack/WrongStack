import { expectDefined } from '@wrongstack/core';
import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted fonts (CSP-clean: served from 'self'). IBM Plex gives the UI an
// engineering-instrument character — Plex Sans (variable) for UI text, Plex
// Mono for data readouts, labels, and code.
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './i18n';
import { App } from './App';
import './index.css';
import './syntax-highlight.css';
import { startAnalyticsFlush } from './lib/analytics';

// Start the analytics flush timer on app init
startAnalyticsFlush();

ReactDOM.createRoot(expectDefined(document.getElementById('root'))).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './styles.css';

// Global safety net for errors that originate outside React's render path
// (event handlers, async callbacks, socket plumbing). Render errors are
// handled by the per-section ErrorBoundary; these handlers make sure nothing
// fails silently. Structured JSON keeps the output grep-friendly.
function logClientError(kind: string, message: string, detail?: unknown): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: `simpleui.${kind}`,
      message,
      detail,
      timestamp: new Date().toISOString(),
    }),
  );
}

window.addEventListener('error', (event) => {
  logClientError('window_error', event.message, {
    source: event.filename,
    line: event.lineno,
    column: event.colno,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  logClientError(
    'unhandled_rejection',
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined,
  );
});

const root = document.getElementById('root');
if (!root) throw new Error('SimpleUI root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import '@fontsource-variable/inter';
import '@fontsource-variable/cinzel';
import '@fontsource/poiret-one/400.css';
import '@fontsource/ibm-plex-mono/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('SimpleUI root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

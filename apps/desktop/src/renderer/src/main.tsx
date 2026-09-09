/**
 * Renderer entry.
 *
 * `connect()` runs before mount so the first paint already has the state
 * snapshot rather than flashing an empty shell and then filling in.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { connect } from './store.js';
import './styles.css';

const container = document.getElementById('app');
if (!container) throw new Error('#app is missing from index.html');

connect();
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

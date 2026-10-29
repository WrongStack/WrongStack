import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyAppearance } from './appearance';
import { cachedAppearance } from './useAppearance';
import './styles.css';
import './chat.css';
import './workspace.css';
import './brand-tokens.css';
import './appearance.css';
import './workbench.css';
import './project.css';
import './files.css';
import './knowledge.css';
import './atlas.css';
import './chronicle.css';
import './git-history.css';
import './skills.css';

applyAppearance(
  cachedAppearance(),
  matchMedia('(prefers-color-scheme: dark)').matches,
  matchMedia('(prefers-contrast: more)').matches,
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

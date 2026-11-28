import './square-corners.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyAppearance } from './appearance';
import { RenderErrorBoundary } from './RenderErrorBoundary';
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
// Last: the application shell overrides the older sidebar and header rules.
import './shell.css';
import './controls.css';
import './settings-workspace.css';
// Last: the IDE workbench's own surface treatment overrides the older shell rules.
import './ide-workbench.css';
// After the workbench: the tinted canvas and the raised working card.
import './shell-canvas.css';

applyAppearance(
  cachedAppearance(),
  matchMedia('(prefers-color-scheme: dark)').matches,
  matchMedia('(prefers-contrast: more)').matches,
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RenderErrorBoundary>
      <App />
    </RenderErrorBoundary>
  </StrictMode>,
);

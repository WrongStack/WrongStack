'use client';

import {
  Coffee,
  Heart,
  LayoutDashboard,
  LayoutGrid,
  List,
  Maximize2,
  Sparkles,
  X,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  readWorkspacePreferences,
  WORKSPACE_PREFERENCES_KEY,
  type WorkspacePreferences,
  type WorkspaceView,
} from '../lib/workspace-preferences';

const Preferences = createContext({
  preferences: DEFAULT_WORKSPACE_PREFERENCES,
  update: (_patch: Partial<WorkspacePreferences>) => {},
});
export function WorkspacePreferencesProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState(DEFAULT_WORKSPACE_PREFERENCES);
  useEffect(() => {
    try {
      setPreferences(readWorkspacePreferences(localStorage.getItem(WORKSPACE_PREFERENCES_KEY)));
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.dataset.workspaceView = preferences.view;
    document.documentElement.dataset.guidance = preferences.guidance ? 'on' : 'off';
    document.documentElement.dataset.collectionView = preferences.collections;
    document.documentElement.dataset.mascot = preferences.mascot;
  }, [preferences.view, preferences.guidance, preferences.collections, preferences.mascot]);
  const update = useCallback((patch: Partial<WorkspacePreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(WORKSPACE_PREFERENCES_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  return <Preferences.Provider value={{ preferences, update }}>{children}</Preferences.Provider>;
}
export const useWorkspacePreferences = () => useContext(Preferences);

export function CollectionViewSwitch() {
  const { preferences, update } = useWorkspacePreferences();
  if (preferences.view === 'studio') return null;
  return (
    <fieldset className="collection-view-switch" aria-label="Collection display">
      <button
        type="button"
        aria-pressed={preferences.collections === 'cards'}
        onClick={() => update({ collections: 'cards' })}
      >
        <LayoutGrid size={13} /> Cards
      </button>
      <button
        type="button"
        aria-pressed={preferences.collections === 'list'}
        onClick={() => update({ collections: 'list' })}
      >
        <List size={13} /> List
      </button>
    </fieldset>
  );
}
const VIEWS = [
  {
    id: 'cozy',
    name: 'Cozy chat',
    description: 'A friendly chat, with a few helpful shortcuts.',
    icon: Coffee,
  },
  {
    id: 'focus',
    name: 'Just chat',
    description: 'A little breathing room. Just you and the conversation.',
    icon: Maximize2,
  },
  {
    id: 'studio',
    name: 'Studio',
    description: 'Your sessions, controls and workspace side by side.',
    icon: LayoutDashboard,
  },
] as const;

export function WorkspaceViewMenu({ onChoose }: { onChoose: (view: WorkspaceView) => void }) {
  const { preferences, update } = useWorkspacePreferences();
  const [open, setOpen] = useState(false);
  const current = VIEWS.find((view) => view.id === preferences.view)!;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="view-trigger"
          aria-label={`Change workspace view: ${current.name}`}
          title="Make yourself at home"
        >
          <current.icon size={15} />
          <span>{current.name}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="view-menu"
          align="end"
          sideOffset={10}
          aria-label="Make yourself at home"
        >
          <div className="view-menu-heading">
            <span>
              <Heart size={16} /> Make yourself at home
            </span>
            <Popover.Close className="icon-button" aria-label="Close view options">
              <X size={15} />
            </Popover.Close>
          </div>
          <p>Choose how much you’d like to see.</p>
          <fieldset className="view-choices" aria-label="Workspace view">
            {VIEWS.map((view) => (
              <button
                type="button"
                key={view.id}
                aria-pressed={preferences.view === view.id}
                onClick={() => {
                  update({ view: view.id });
                  onChoose(view.id);
                  setOpen(false);
                }}
              >
                <view.icon size={20} />
                <span>
                  <strong>{view.name}</strong>
                  <small>{view.description}</small>
                </span>
                <span className="view-choice-dot" />
              </button>
            ))}
          </fieldset>
          <fieldset className="comfort-options" aria-label="Little extras">
            <legend>Little extras · always optional</legend>
            {(
              [
                ['ideas', 'Inspiration cards'],
                ['shortcuts', 'Quick shortcuts'],
                ['guidance', 'Helpful introductions'],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="checkbox"
                  checked={preferences[key]}
                  onChange={(event) => update({ [key]: event.target.checked })}
                />
              </label>
            ))}
          </fieldset>
          <label className="mascot-preference">
            <span>
              Little mascot<small>Your Cozy chat companion</small>
            </span>
            <select
              aria-label="Little mascot"
              value={preferences.mascot}
              onChange={(event) =>
                update({ mascot: event.target.value as 'roam' | 'quiet' | 'off' })
              }
            >
              <option value="roam">Wander a little</option>
              <option value="quiet">Sit quietly</option>
              <option value="off">Sleep · hide</option>
            </select>
          </label>
          <span className="view-saved">
            <Sparkles size={12} /> Your choices stay on this device.
          </span>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function FriendlyIntro({
  id,
  label,
  children,
  className = '',
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { preferences, update } = useWorkspacePreferences();
  if (!preferences.guidance) return null;
  const hidden = preferences.hiddenIntros.includes(id);
  return hidden ? (
    <div className="intro-folded">
      <button
        type="button"
        aria-label={`Show ${label} introduction`}
        onClick={() =>
          update({ hiddenIntros: preferences.hiddenIntros.filter((item) => item !== id) })
        }
      >
        <Sparkles size={12} /> A little guide <span>+</span>
      </button>
    </div>
  ) : (
    <div className={`explorer-intro friendly-intro ${className}`}>
      {children}
      <button
        type="button"
        className="icon-button intro-dismiss"
        aria-label={`Hide ${label} introduction`}
        title="Tuck this away"
        onClick={() => update({ hiddenIntros: [...preferences.hiddenIntros, id] })}
      >
        <X size={14} />
      </button>
    </div>
  );
}

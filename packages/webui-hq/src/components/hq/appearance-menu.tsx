/**
 * Appearance menu — theme and accent palette.
 *
 * Both settings write to local prefs; `AppShell` is what actually touches the
 * DOM, so there is exactly one place that knows about `.dark` and
 * `data-palette`.
 */
import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import type * as React from 'react';
import {
  HQ_PALETTE_IDS,
  type HqPaletteId,
  type HqThemeChoice,
  setHqAppearancePrefs,
  useHqLocalPrefs,
} from '../../data/local-prefs.js';
import { Button } from '../ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';

const THEMES: { id: HqThemeChoice; label: string; icon: React.ElementType }[] = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'system', label: 'System', icon: Monitor },
];

function paletteLabel(id: HqPaletteId): string {
  if (id === 'signal') return 'Signal (default)';
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' / ');
}

export function AppearanceMenu(): React.ReactElement {
  const { theme, palette } = useHqLocalPrefs().appearance;
  const ThemeIcon = THEMES.find((entry) => entry.id === theme)?.icon ?? Moon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Appearance" title="Appearance">
          <ThemeIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setHqAppearancePrefs({ theme: value as HqThemeChoice })}
        >
          {THEMES.map(({ id, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={id} value={id}>
              <Icon className="size-3.5" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel>
          <span className="inline-flex items-center gap-1">
            <Palette className="size-3" />
            Accent
          </span>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={palette}
          onValueChange={(value) => setHqAppearancePrefs({ palette: value as HqPaletteId })}
        >
          {HQ_PALETTE_IDS.map((id) => (
            <DropdownMenuRadioItem key={id} value={id}>
              {paletteLabel(id)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

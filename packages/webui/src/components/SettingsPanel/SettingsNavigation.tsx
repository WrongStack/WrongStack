import { ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { i18n, useAppTranslation } from '@/i18n';
import { TabsList, TabsTrigger } from '../ui/tabs';

export interface SettingsTab {
  id: string;
  icon: React.ReactNode;
  labelKey: string;
  descKey?: string;
}

const GROUPS = [
  { key: 'workspace', tabs: ['general', 'fonts', 'display'] },
  { key: 'models', tabs: ['provider', 'jev', 'connection', 'fallbacks', 'routing'] },
  { key: 'behavior', tabs: ['agent', 'execution', 'fleet', 'chimera', 'context'] },
  { key: 'system', tabs: ['integrations', 'logs', 'security'] },
] as const;

const SEARCH_SECTIONS: Record<string, string[]> = {
  general: ['general'],
  fonts: ['fonts'],
  display: ['display'],
  provider: ['provider', 'providerModels', 'model', 'oauth', 'modelSchema'],
  jev: ['jev'],
  connection: ['connection'],
  fallbacks: ['fallbacks'],
  routing: ['agent'],
  chimera: ['features'],
  agent: ['agent'],
  execution: ['execution'],
  fleet: ['fleet'],
  integrations: ['integrations', 'mcp'],
  context: ['context'],
  logs: ['logs'],
  security: ['security', 'brain', 'brainOpt', 'allowlist'],
};

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return Object.values(value).map(collectText).join(' ');
}

export function SettingsNavigation({
  tabs,
  activeTab,
  onSelect,
}: {
  tabs: SettingsTab[];
  activeTab: string;
  onSelect: (tab: string) => void;
}) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchIndex = useMemo(
    () =>
      new Map(
        tabs.map((tab) => [
          tab.id,
          [
            t(tab.labelKey),
            tab.descKey ? t(tab.descKey) : '',
            ...(SEARCH_SECTIONS[tab.id] ?? []).map((section) =>
              collectText(i18n.getResource(i18n.language, 'settings', section)),
            ),
          ]
            .join(' ')
            .toLocaleLowerCase(),
        ]),
      ),
    [tabs, t],
  );
  const matches = useMemo(
    () => tabs.filter((tab) => searchIndex.get(tab.id)?.includes(normalizedQuery)),
    [tabs, normalizedQuery, searchIndex],
  );
  const active = tabs.find((tab) => tab.id === activeTab);

  // Radix activates a tab on pointer-down, before the browser emits click.
  // The selected trigger can be replaced during that render, so its onClick
  // is not a reliable place to close the mobile picker or clear the search.
  useEffect(() => {
    setMobileOpen(false);
    setQuery('');
  }, [activeTab]);

  const select = (value: string) => {
    onSelect(value);
    setMobileOpen(false);
    setQuery('');
  };

  return (
    <nav
      aria-label={t('settings:navigation.label')}
      className="ws-settings-nav min-w-0 lg:sticky lg:top-4"
    >
      <button
        type="button"
        aria-expanded={mobileOpen}
        aria-controls="settings-navigation-list"
        onClick={() => setMobileOpen((open) => !open)}
        className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-border bg-card px-3 text-left shadow-sm lg:hidden"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
          {active?.icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {active ? t(active.labelKey) : t('settings:title')}
        </span>
        <span className="text-xs text-muted-foreground">{t('settings:navigation.browse')}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      <div
        id="settings-navigation-list"
        className={`${mobileOpen ? 'block' : 'hidden'} mt-2 rounded-xl border border-border/70 bg-card/90 p-2 shadow-sm lg:mt-0 lg:block lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto`}
      >
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t('settings:navigation.search')}
            placeholder={t('settings:navigation.search')}
            className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('settings:navigation.clearSearch')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <TabsList
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]:not([disabled])',
              ),
            );
            const index = items.indexOf(event.target as HTMLButtonElement);
            if (index < 0 || items.length < 2) return;
            event.preventDefault();
            event.stopPropagation();
            items[
              (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
            ]?.focus();
          }}
          className="flex h-auto w-full flex-col items-stretch gap-0 rounded-none border-0 bg-transparent p-0"
        >
          {GROUPS.map((group) => {
            const groupTabs = group.tabs
              .map((id) => matches.find((tab) => tab.id === id))
              .filter((tab): tab is SettingsTab => Boolean(tab));
            if (groupTabs.length === 0) return null;
            return (
              <div key={group.key} className="w-full pt-2 first:pt-0">
                <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t(`settings:navigation.${group.key}`)}
                </p>
                {groupTabs.map((tab) => (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    onClick={() => select(tab.id)}
                    className="min-h-9 w-full justify-start gap-3 rounded-lg border-0 px-3 text-left text-sm font-normal data-[state=active]:bg-primary/10 data-[state=active]:font-semibold data-[state=active]:text-primary data-[state=active]:shadow-none"
                  >
                    <span className="shrink-0">{tab.icon}</span>
                    <span className="truncate">{t(tab.labelKey)}</span>
                  </TabsTrigger>
                ))}
              </div>
            );
          })}
        </TabsList>
        {matches.length === 0 && (
          <p role="status" className="px-3 py-5 text-center text-sm text-muted-foreground">
            {t('settings:navigation.noResults')}
          </p>
        )}
      </div>
    </nav>
  );
}

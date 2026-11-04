import { ArrowLeft, ChevronRight, Home, Network, Radio } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { PageMotif } from '../ui/PageMotif';
import type { LiveAgentPresence } from './codemap-activity-store';
import type { CodeMapGraphResponse, CodeMapScope } from './codemap-model';
import { relativeFilePath } from './codemap-model';

interface CodeMapHeaderProps {
  scope: CodeMapScope;
  graph: CodeMapGraphResponse;
  agentPresences: LiveAgentPresence[];
  edgeWeight: number;
  connectedNodeCount: number;
  navigate: (nextScope: CodeMapScope, preferredSelection?: string) => void;
  /** The application's own controls (the desktop's index button), after the counters. */
  actions?: React.ReactNode;
}

export function CodeMapHeader({
  scope,
  graph,
  agentPresences,
  edgeWeight,
  connectedNodeCount,
  navigate,
  actions,
}: CodeMapHeaderProps): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <header className="ws-page-header flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b">
      <PageMotif kind="network" />
      <div className="flex min-w-[220px] items-center gap-3">
        <span className="ws-page-icon flex h-9 w-9 items-center justify-center border border-primary bg-primary/10 text-primary">
          <Network className="h-4 w-4" />
        </span>
        <div>
          <h1 className="font-display tracking-tight">{t('activity:codeMap.codeAtlas')}</h1>
          <p className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            {t('activity:codeMap.architectureIntelligence')}
          </p>
        </div>
      </div>
      <nav
        className="order-last flex w-full min-w-0 items-center gap-1 overflow-x-auto border-t pt-2 font-mono text-[11px] [&>button]:shrink-0 [&>svg]:shrink-0"
        aria-label={t('activity:codeMap.codeMapBreadcrumb')}
      >
        {scope.level !== 'packages' && (
          <button
            type="button"
            className="mr-1 flex h-7 w-7 items-center justify-center border text-muted-foreground hover:bg-muted"
            onClick={() => {
              if (scope.level === 'symbols')
                navigate(
                  { level: 'files', package: scope.package ?? '(root)' },
                  `file:${scope.file}`,
                );
              else navigate({ level: 'packages' });
            }}
            aria-label={t('activity:codeMap.back')}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          className="flex items-center gap-1.5 px-1.5 py-1 text-muted-foreground hover:text-foreground"
          onClick={() => navigate({ level: 'packages' })}
          aria-current={scope.level === 'packages' ? 'page' : undefined}
        >
          <Home className="h-3 w-3" /> {t('activity:codeMapText.workspace')}
        </button>
        {scope.level !== 'packages' && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              className="whitespace-nowrap px-1.5 py-1 hover:text-primary"
              aria-current={scope.level === 'files' ? 'page' : undefined}
              onClick={() => navigate({ level: 'files', package: scope.package ?? '(root)' })}
            >
              {scope.package ?? '(root)'}
            </button>
          </>
        )}
        {scope.level === 'symbols' && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <span
              className="whitespace-nowrap px-1.5 py-1 text-primary"
              aria-current="page"
              title={scope.file}
            >
              {relativeFilePath({
                id: '',
                label: scope.file,
                kind: 'file',
                file: scope.file,
                package: scope.package,
              })}
            </span>
          </>
        )}
      </nav>
      <div className="ml-auto hidden items-center gap-5 xl:flex">
        <div
          className={cn(
            'flex h-8 items-center gap-2 border px-2.5',
            agentPresences.length > 0
              ? 'border-success/50 bg-success/10 text-success'
              : 'text-muted-foreground',
          )}
        >
          <Radio className={cn('h-3 w-3', agentPresences.length > 0 && 'animate-pulse')} />
          <div>
            <div className="font-mono text-[10px] font-bold">{agentPresences.length} LIVE</div>
            <div className="text-[7px] uppercase tracking-wider">
              {t('activity:codeMapText.agents')}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold">{graph.nodes.length}</div>
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
            {t('activity:codeMapText.nodes')}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold">{graph.edges.length}</div>
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
            {t('activity:codeMapText.links')}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold">{edgeWeight}</div>
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
            {t('activity:codeMapText.references')}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold">{connectedNodeCount}</div>
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
            {t('activity:codeMapText.connected')}
          </div>
        </div>
      </div>
      {actions && <div className="ml-auto flex items-center gap-2 xl:ml-0">{actions}</div>}
    </header>
  );
}

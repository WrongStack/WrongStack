import { ArrowLeft, ChevronRight, Home, Network, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LiveAgentPresence } from '@/stores/codemap-activity-store';
import type { CodeMapGraphResponse, CodeMapScope } from './codemap-model';
import { relativeFilePath } from './codemap-model';
import { useAppTranslation } from '@/i18n';

interface CodeMapHeaderProps {
  scope: CodeMapScope;
  graph: CodeMapGraphResponse;
  agentPresences: LiveAgentPresence[];
  edgeWeight: number;
  connectedNodeCount: number;
  navigate: (nextScope: CodeMapScope, preferredSelection?: string) => void;
}

export function CodeMapHeader({
  scope,
  graph,
  agentPresences,
  edgeWeight,
  connectedNodeCount,
  navigate,
}: CodeMapHeaderProps): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <header className="flex h-[62px] shrink-0 items-center gap-4 border-b bg-card px-4">
      <div className="flex min-w-[220px] items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center border border-primary bg-primary/10 text-primary">
          <Network className="h-4 w-4" />
        </span>
        <div>
          <h1 className="font-display text-sm font-semibold tracking-tight">
            {t('activity:codeMap.codeAtlas')}
          </h1>
          <p className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            {t('activity:codeMap.architectureIntelligence')}
          </p>
        </div>
      </div>
      <nav
        className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[10px]"
        aria-label={t('activity:codeMap.codeMapBreadcrumb')}
      >
        {scope.level !== 'packages' && (
          <button
            type="button"
            className="mr-1 flex h-7 w-7 items-center justify-center border text-muted-foreground hover:bg-muted"
            onClick={() => {
              if (scope.level === 'symbols')
                navigate({ level: 'files', package: scope.package ?? '(root)' });
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
        >
          <Home className="h-3 w-3" /> workspace
        </button>
        {scope.level !== 'packages' && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              className="max-w-[220px] truncate px-1.5 py-1 hover:text-primary"
              onClick={() => navigate({ level: 'files', package: scope.package ?? '(root)' })}
            >
              {scope.package ?? '(root)'}
            </button>
          </>
        )}
        {scope.level === 'symbols' && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <span className="truncate px-1.5 py-1 text-primary">
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
      <div className="hidden items-center gap-5 xl:flex">
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
            <div className="text-[7px] uppercase tracking-wider">agents</div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold">{graph.nodes.length}</div>
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground">nodes</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold">{graph.edges.length}</div>
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground">links</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold">{edgeWeight}</div>
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
            references
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold">{connectedNodeCount}</div>
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground">connected</div>
        </div>
      </div>
    </header>
  );
}

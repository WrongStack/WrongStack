import {
  ArrowDown,
  Braces,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  FileCode2,
  Filter,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  Loader2,
  RefreshCw,
  Search,
  Tag,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { useConfigStore, useGitChangesStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import { DiffView } from './DiffView';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

type HistoryPayload = Extract<WSServerMessage, { type: 'git.history' }>['payload'];
type HistoryCommit = HistoryPayload['commits'][number];
type HistoryRef = HistoryPayload['refs'][number];
type DetailPayload = Extract<WSServerMessage, { type: 'git.commit_detail' }>['payload'];
type FileDiffPayload = Extract<WSServerMessage, { type: 'git.commit_file_diff' }>['payload'];

const LANE_COLORS = ['#9b87f5', '#37c9a2', '#f2b95f', '#67a7ff', '#e879b8', '#f07178'];
const ROW_HEIGHT = 48;
const LANE_GAP = 15;

export const COMMIT_DETAIL_PANEL_CLASS =
  'flex h-[44%] min-h-[230px] max-h-[460px] shrink-0 flex-col overflow-hidden border-t border-border/70 bg-card/35 shadow-[0_-16px_40px_-34px_hsl(var(--primary)/0.8)] sm:h-[36%] sm:max-h-[390px] sm:flex-row';

interface GraphLayout {
  lanes: number[];
  laneCount: number;
  edges: Array<{ fromRow: number; fromLane: number; toRow: number; toLane: number }>;
}

/** Stable topology layout: first parent continues a lane, merge parents fan out. */
export function layoutCommitGraph(commits: HistoryCommit[]): GraphLayout {
  const slots: Array<string | undefined> = [];
  const lanes: number[] = [];
  const rowByHash = new Map(commits.map((commit, index) => [commit.hash, index]));
  for (const commit of commits) {
    let lane = slots.indexOf(commit.hash);
    if (lane < 0) {
      lane = slots.indexOf(undefined);
      if (lane < 0) lane = slots.length;
    }
    lanes.push(lane);
    slots[lane] = commit.parents[0];
    for (const parent of commit.parents.slice(1)) {
      if (slots.includes(parent)) continue;
      let parentLane = slots.indexOf(undefined);
      if (parentLane < 0) parentLane = slots.length;
      slots[parentLane] = parent;
    }
  }
  const laneByHash = new Map(commits.map((commit, index) => [commit.hash, lanes[index] ?? 0]));
  const edges = commits.flatMap((commit, fromRow) =>
    commit.parents.flatMap((parent) => {
      const toRow = rowByHash.get(parent);
      if (toRow === undefined) return [];
      return [
        { fromRow, fromLane: lanes[fromRow] ?? 0, toRow, toLane: laneByHash.get(parent) ?? 0 },
      ];
    }),
  );
  return { lanes, laneCount: Math.max(1, ...lanes.map((lane) => lane + 1)), edges };
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return value;
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function refTone(ref: string): string {
  if (ref.startsWith('tag: ')) return 'border-amber-400/35 bg-amber-400/10 text-amber-500';
  if (ref.includes('/')) return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-500';
  return 'border-violet-400/35 bg-violet-400/12 text-violet-400';
}

function GraphCanvas({ commits, layout }: { commits: HistoryCommit[]; layout: GraphLayout }) {
  const width = 22 + layout.laneCount * LANE_GAP;
  return (
    <svg
      aria-label="Commit topology"
      className="pointer-events-none absolute inset-y-0 left-0"
      width={width}
      height={commits.length * ROW_HEIGHT}
      viewBox={`0 0 ${width} ${commits.length * ROW_HEIGHT}`}
    >
      {layout.edges.map((edge, index) => {
        const x1 = 14 + edge.fromLane * LANE_GAP;
        const x2 = 14 + edge.toLane * LANE_GAP;
        const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
        const y2 = edge.toRow * ROW_HEIGHT + ROW_HEIGHT / 2;
        const bend = Math.min(18, Math.max(8, (y2 - y1) * 0.35));
        return (
          <path
            key={`${edge.fromRow}-${edge.toRow}-${index}`}
            d={`M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`}
            fill="none"
            stroke={LANE_COLORS[edge.fromLane % LANE_COLORS.length]}
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.9"
          />
        );
      })}
      {commits.map((commit, row) => {
        const lane = layout.lanes[row] ?? 0;
        const merge = commit.parents.length > 1;
        return (
          <g key={commit.hash}>
            <circle
              cx={14 + lane * LANE_GAP}
              cy={row * ROW_HEIGHT + ROW_HEIGHT / 2}
              r={merge ? 5 : 4}
              fill="hsl(var(--background))"
              stroke={LANE_COLORS[lane % LANE_COLORS.length]}
              strokeWidth={merge ? 2.5 : 2}
            />
            {!merge && (
              <circle
                cx={14 + lane * LANE_GAP}
                cy={row * ROW_HEIGHT + ROW_HEIGHT / 2}
                r="1.5"
                fill={LANE_COLORS[lane % LANE_COLORS.length]}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function RefList({
  refs,
  activeRef,
  onSelect,
}: {
  refs: HistoryRef[];
  activeRef: string;
  onSelect: (ref: string) => void;
}) {
  const groups = [
    { kind: 'local' as const, label: 'Local branches', icon: GitBranch },
    { kind: 'remote' as const, label: 'Remotes', icon: GitFork },
    { kind: 'tag' as const, label: 'Tags', icon: Tag },
  ];
  return (
    <aside className="hidden min-h-0 w-[218px] shrink-0 flex-col border-r border-border/70 bg-card/35 xl:flex">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Repository
        </div>
        <button
          type="button"
          onClick={() => onSelect('')}
          className={cn(
            'mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
            activeRef === ''
              ? 'bg-primary/12 text-primary'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <Braces className="h-3.5 w-3.5" /> All branches
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {groups.map(({ kind, label, icon: Icon }) => {
          const items = refs.filter((ref) => ref.kind === kind);
          if (items.length === 0) return null;
          return (
            <section key={kind} className="mb-5">
              <div className="mb-1 flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/75">
                <Icon className="h-3 w-3" /> {label}
                <span className="ml-auto font-mono">{items.length}</span>
              </div>
              {items.map((ref) => (
                <button
                  key={ref.name}
                  type="button"
                  onClick={() => onSelect(ref.name)}
                  title={ref.name}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors',
                    activeRef === ref.name
                      ? 'bg-primary/12 text-primary'
                      : 'text-muted-foreground hover:bg-muted/55 hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      ref.current
                        ? 'bg-primary shadow-[0_0_8px_hsl(var(--primary))]'
                        : 'bg-muted-foreground/45',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{ref.shortName}</span>
                  {ref.current && <Check className="h-3 w-3" />}
                </button>
              ))}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function CommitDetail({
  commit,
  detail,
  loading,
  onOpenFile,
}: {
  commit: HistoryCommit | null;
  detail: DetailPayload | null;
  loading: boolean;
  onOpenFile: (file: NonNullable<DetailPayload['files']>[number]) => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!commit) {
    return (
      <section className="flex h-[34%] min-h-[210px] shrink-0 items-center justify-center border-t border-border/70 bg-card/30 p-6 text-center text-xs text-muted-foreground">
        Select a commit to inspect its files and metadata.
      </section>
    );
  }
  const files = detail?.files ?? [];
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const deleted = files.reduce((sum, file) => sum + file.deleted, 0);
  const body = detail?.body?.split(/\r?\n/).slice(1).join('\n').trim();
  return (
    <section className={COMMIT_DETAIL_PANEL_CLASS}>
      <div className="w-full max-w-none shrink-0 overflow-y-auto border-b border-border/70 px-5 py-4 sm:w-[34%] sm:min-w-[250px] sm:max-w-[440px] sm:border-b-0 sm:border-r">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.17em] text-muted-foreground">
          <CircleDot className="h-3.5 w-3.5 text-primary" /> Commit details
        </div>
        <h2 className="mt-3 text-sm font-semibold leading-5 text-foreground">{commit.subject}</h2>
        <div className="mt-3 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-[10px] font-bold text-primary">
            {initials(commit.author)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{commit.author}</div>
            <div className="truncate text-[10px] text-muted-foreground">{commit.email}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard?.writeText(commit.hash);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="mt-4 flex w-full items-center justify-between rounded-lg border border-border/70 bg-background/55 px-3 py-2 font-mono text-[11px] text-muted-foreground hover:border-primary/35 hover:text-foreground"
        >
          <span>{shortHash(commit.hash)}</span>
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
        <div className="mt-3 grid grid-cols-2 overflow-hidden rounded-lg border border-border/70">
          <div className="border-r border-border/70 p-3">
            <div className="text-lg font-semibold tabular-nums">{files.length}</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Files</div>
          </div>
          <div className="p-3">
            <div className="font-mono text-xs">
              <span className="text-success">+{added}</span>{' '}
              <span className="text-destructive">-{deleted}</span>
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Lines
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" />
          {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
            new Date(commit.authoredAt),
          )}
        </div>
        {commit.parents.length > 1 && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-violet-400">
            <GitMerge className="h-3.5 w-3.5" />
            Merge of {commit.parents.length} parents
          </div>
        )}
        {body && (
          <p className="mt-4 whitespace-pre-wrap rounded-lg border border-border/60 bg-background/45 px-3 py-2.5 text-[11px] leading-5 text-muted-foreground">
            {body}
          </p>
        )}
        {commit.refs.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {commit.refs.map((ref) => (
              <span
                key={ref}
                className={cn('rounded-md border px-1.5 py-0.5 text-[9px]', refTone(ref))}
              >
                {ref.replace(/^tag: /, '')}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
        <div className="mt-5 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
          Changed files
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading changes…
          </div>
        ) : detail?.error ? (
          <div className="py-5 text-xs text-destructive">{detail.error}</div>
        ) : (
          <div className="mt-2 space-y-1">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => onOpenFile(file)}
                className="group w-full rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/[0.055]"
              >
                <div className="flex items-center gap-2">
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[11px]" title={file.path}>
                    {file.path}
                  </span>
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
                </div>
                <div className="mt-1 pl-5 font-mono text-[10px]">
                  <span className="text-success">+{file.added}</span>
                  <span className="ml-2 text-destructive">-{file.deleted}</span>
                </div>
              </button>
            ))}
            {files.length === 0 && (
              <div className="py-5 text-xs text-muted-foreground">No file changes reported.</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function RepositoryHistoryView() {
  const { client } = useWebSocket();
  const connected = useConfigStore((state) => state.wsConnected);
  const changedFiles = useGitChangesStore((state) => state.files);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [activeRef, setActiveRef] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fileDiff, setFileDiff] = useState<FileDiffPayload | null>(null);
  const [fileDiffOpen, setFileDiffOpen] = useState(false);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const selectedHashRef = useRef<string | null>(null);
  const fileDiffTargetRef = useRef<string | null>(null);
  selectedHashRef.current = selectedHash;

  const requestHistory = useCallback(
    (ref: string, skip = 0) => {
      if (!client || !connected) return;
      setLoading(true);
      client.getGitHistory({ ...(ref ? { ref } : {}), limit: 160, skip });
      client.getGitChanges();
    },
    [client, connected],
  );

  useEffect(() => {
    if (!client) return;
    const offHistory = client.on('git.history', (message) => {
      setHistory((previous) =>
        message.payload.skip > 0 && previous
          ? {
              ...message.payload,
              commits: [...previous.commits, ...message.payload.commits],
              refs: previous.refs,
            }
          : message.payload,
      );
      setLoading(false);
      const first = message.payload.commits[0]?.hash ?? null;
      setSelectedHash((current) =>
        message.payload.skip > 0
          ? current
          : current && message.payload.commits.some((commit) => commit.hash === current)
            ? current
            : first,
      );
    });
    const offDetail = client.on('git.commit_detail', (message) => {
      if (message.payload.hash !== selectedHashRef.current) return;
      setDetail(message.payload);
      setDetailLoading(false);
    });
    const offFileDiff = client.on('git.commit_file_diff', (message) => {
      if (`${message.payload.hash}:${message.payload.path}` !== fileDiffTargetRef.current) return;
      setFileDiff(message.payload);
      setFileDiffLoading(false);
    });
    requestHistory('');
    return () => {
      offHistory();
      offDetail();
      offFileDiff();
    };
  }, [client, requestHistory]);

  useEffect(() => {
    if (!selectedHash || !client) return;
    setDetail(null);
    setDetailLoading(true);
    client.getGitCommitDetail(selectedHash);
  }, [client, selectedHash]);

  const visibleCommits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return history?.commits ?? [];
    return (history?.commits ?? []).filter((commit) =>
      `${commit.subject} ${commit.author} ${commit.email} ${commit.hash} ${commit.refs.join(' ')}`
        .toLowerCase()
        .includes(needle),
    );
  }, [history?.commits, query]);
  const layout = useMemo(() => layoutCommitGraph(visibleCommits), [visibleCommits]);
  const graphWidth = 22 + layout.laneCount * LANE_GAP;
  const selected = history?.commits.find((commit) => commit.hash === selectedHash) ?? null;
  const insights = useMemo(() => {
    const commits = history?.commits ?? [];
    return {
      commits: commits.length,
      contributors: new Set(commits.map((commit) => commit.email || commit.author)).size,
      merges: commits.filter((commit) => commit.parents.length > 1).length,
      branches: (history?.refs ?? []).filter((ref) => ref.kind !== 'tag').length,
    };
  }, [history]);

  const selectRef = (ref: string) => {
    setActiveRef(ref);
    setSelectedHash(null);
    setDetail(null);
    requestHistory(ref);
  };
  const moveSelection = (direction: number) => {
    if (visibleCommits.length === 0) return;
    const index = Math.max(
      0,
      visibleCommits.findIndex((commit) => commit.hash === selectedHash),
    );
    setSelectedHash(
      visibleCommits[Math.max(0, Math.min(visibleCommits.length - 1, index + direction))]?.hash ??
        null,
    );
  };
  const openCommitFile = (file: NonNullable<DetailPayload['files']>[number]) => {
    if (!client || !selectedHash) return;
    fileDiffTargetRef.current = `${selectedHash}:${file.path}`;
    setFileDiff(null);
    setFileDiffLoading(true);
    setFileDiffOpen(true);
    client.getGitCommitFileDiff(selectedHash, file.path, file.previousPath);
  };

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_48%_-20%,hsl(var(--primary)/0.10),transparent_42%),hsl(var(--background))]"
      data-testid="repository-history-view"
    >
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <RefList refs={history?.refs ?? []} activeRef={activeRef} onSelect={selectRef} />
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-border/70 bg-card/30 px-4 py-3 backdrop-blur-xl sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-[0_0_22px_hsl(var(--primary)/0.12)]">
                    <GitFork className="h-4 w-4" />
                  </span>
                  <div>
                    <h1 className="text-base font-semibold tracking-tight">Repository history</h1>
                    <p className="text-[11px] text-muted-foreground">
                      Every branch. One clear picture.
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden rounded-full border border-border/70 bg-background/55 px-2.5 py-1 font-mono text-[10px] text-muted-foreground sm:inline-flex">
                  <GitBranch className="mr-1.5 h-3 w-3 text-primary" />
                  {history?.currentBranch || '—'}
                </span>
                <button
                  type="button"
                  onClick={() => requestHistory(activeRef)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/55 px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/35 hover:text-foreground"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                  Refresh
                </button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search commits, authors, hashes…"
                  className="h-9 w-full rounded-lg border border-border/70 bg-background/60 pl-9 pr-3 text-xs outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
                />
              </label>
              <label className="relative xl:hidden">
                <Filter className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <select
                  value={activeRef}
                  onChange={(event) => selectRef(event.target.value)}
                  className="h-9 max-w-[190px] appearance-none rounded-lg border border-border/70 bg-background/60 pl-8 pr-7 text-xs outline-none"
                >
                  <option value="">All branches</option>
                  {history?.refs.map((ref) => (
                    <option key={ref.name} value={ref.name}>
                      {ref.shortName}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </header>

          <div className="grid h-10 shrink-0 grid-cols-4 divide-x divide-border/60 border-b border-border/70 bg-card/20">
            {[
              ['Commits', insights.commits],
              ['Branches', insights.branches],
              ['Contributors', insights.contributors],
              ['Merges', insights.merges],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-center gap-2 px-2">
                <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                  {value}
                </span>
                <span className="hidden text-[9px] font-semibold uppercase tracking-wider text-muted-foreground sm:inline">
                  {label}
                </span>
              </div>
            ))}
          </div>

          {changedFiles.length > 0 && (
            <button
              type="button"
              onClick={() => showPanel('changes')}
              className="group flex h-10 shrink-0 items-center gap-3 border-b border-border/70 bg-primary/[0.055] px-4 text-left text-xs hover:bg-primary/[0.09]"
            >
              <span className="h-2 w-2 animate-pulse rounded-full border border-primary bg-background" />
              <span className="font-medium">Working changes</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {changedFiles.length}
              </span>
              <span className="text-muted-foreground">Your next chapter starts here</span>
              <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          )}

          <div className="grid h-7 shrink-0 grid-cols-[minmax(0,1fr)_120px_82px_48px] items-center border-b border-border/70 bg-muted/20 px-3 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground sm:grid-cols-[minmax(0,1fr)_160px_92px_58px]">
            <span style={{ paddingLeft: graphWidth + 10 }}>Graph / commit message</span>
            <span>Author</span>
            <span>Commit</span>
            <span>When</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading && !history ? (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Mapping repository history…
              </div>
            ) : history?.error ? (
              <div className="flex h-full items-center justify-center p-8 text-sm text-destructive">
                {history.error}
              </div>
            ) : visibleCommits.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <GitCommitHorizontal className="h-7 w-7 opacity-45" />
                No commits match this view.
              </div>
            ) : (
              <div
                className="relative min-w-[700px]"
                style={{ height: visibleCommits.length * ROW_HEIGHT }}
              >
                <GraphCanvas commits={visibleCommits} layout={layout} />
                {visibleCommits.map((commit, row) => {
                  const active = commit.hash === selectedHash;
                  return (
                    <button
                      key={commit.hash}
                      type="button"
                      onClick={() => setSelectedHash(commit.hash)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' || event.key === 'j') {
                          event.preventDefault();
                          moveSelection(1);
                        }
                        if (event.key === 'ArrowUp' || event.key === 'k') {
                          event.preventDefault();
                          moveSelection(-1);
                        }
                      }}
                      className={cn(
                        'absolute left-0 grid w-full grid-cols-[minmax(0,1fr)_120px_82px_48px] items-center border-b border-border/45 pr-3 text-left transition-colors sm:grid-cols-[minmax(0,1fr)_160px_92px_58px]',
                        active
                          ? 'bg-primary/[0.075] shadow-[inset_2px_0_hsl(var(--primary))]'
                          : 'hover:bg-muted/35',
                      )}
                      style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}
                    >
                      <div
                        className="flex min-w-0 items-center gap-2"
                        style={{ paddingLeft: graphWidth + 10 }}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          {commit.refs.slice(0, 2).map((ref) => (
                            <span
                              key={ref}
                              className={cn(
                                'hidden max-w-[170px] shrink-0 truncate rounded-md border px-1.5 py-0.5 text-[9px] font-medium md:inline',
                                refTone(ref),
                              )}
                            >
                              {ref.replace(/^tag: /, '')}
                            </span>
                          ))}
                          <span
                            className={cn(
                              'truncate text-xs',
                              active ? 'font-semibold text-foreground' : 'text-foreground/90',
                            )}
                          >
                            {commit.subject}
                          </span>
                          {commit.parents.length > 1 && (
                            <GitMerge className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                          )}
                        </div>
                      </div>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-bold text-muted-foreground">
                          {initials(commit.author)}
                        </span>
                        <span className="truncate text-[10px] text-muted-foreground">
                          {commit.author}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {shortHash(commit.hash)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {relativeTime(commit.authoredAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <footer className="flex h-7 shrink-0 items-center border-t border-border/70 bg-card/25 px-4 text-[9px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
              Commit
            </span>
            <span className="ml-4 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full border border-emerald-400" />
              Merge
            </span>
            <span className="ml-auto font-mono">
              {visibleCommits.length} commits · topological order
            </span>
            {history?.hasMore && !query && (
              <button
                type="button"
                onClick={() => requestHistory(activeRef, history.commits.length)}
                disabled={loading}
                className="ml-3 rounded border border-border/70 px-1.5 py-0.5 font-sans text-[9px] font-semibold uppercase tracking-wider hover:border-primary/40 hover:text-primary disabled:opacity-50"
              >
                Load more
              </button>
            )}
            <ArrowDown className="ml-2 h-3 w-3" />
          </footer>
        </section>
      </div>
      <CommitDetail
        commit={selected}
        detail={detail}
        loading={detailLoading}
        onOpenFile={openCommitFile}
      />
      <Dialog open={fileDiffOpen} onOpenChange={setFileDiffOpen}>
        <DialogContent className="h-[min(86dvh,860px)] max-w-[min(94vw,1180px)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:p-0">
          <DialogHeader className="border-b border-border/70 bg-card/80 px-5 py-4 pr-12">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                <FileCode2 className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="truncate font-mono text-sm">
                  {fileDiff?.path ?? 'Commit file diff'}
                </DialogTitle>
                <DialogDescription className="mt-1 flex items-center gap-2 text-[11px]">
                  <span className="font-mono">{fileDiff ? shortHash(fileDiff.hash) : '—'}</span>
                  {fileDiff?.previousPath && fileDiff.previousPath !== fileDiff.path && (
                    <span className="truncate">renamed from {fileDiff.previousPath}</span>
                  )}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="min-h-0 overflow-hidden bg-[hsl(var(--surface-2)/0.45)] p-3">
            <div className="flex h-full min-h-0 overflow-hidden rounded-lg border border-border/70 bg-background/70">
              {fileDiffLoading || !fileDiff ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading revision diff…
                </div>
              ) : fileDiff.error ? (
                <div className="flex flex-1 items-center justify-center p-8 text-sm text-destructive">
                  {fileDiff.error}
                </div>
              ) : fileDiff.binary ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  Binary files cannot be displayed as text.
                </div>
              ) : fileDiff.tooLarge ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  This revision is too large for the inline diff viewer.
                </div>
              ) : (
                <DiffView
                  oldText={fileDiff.oldText ?? ''}
                  newText={fileDiff.newText ?? ''}
                  caption={fileDiff.path}
                  fill
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

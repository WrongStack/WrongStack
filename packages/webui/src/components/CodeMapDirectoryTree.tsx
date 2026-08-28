import {
  Box,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode,
  Folder,
  FolderOpen,
  Loader2,
  Radio,
} from 'lucide-react';
import { memo } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { CodeMapGraphResponse, DirectoryNode, GraphNodeData } from './codemap-model';
import { normalizedPath, scopeKey } from './codemap-model';

const MAX_TREE_FILES_VISIBLE = 80;
const MAX_TREE_SYMBOLS_VISIBLE = 40;

interface DirectoryBranchProps {
  directory: DirectoryNode;
  packageName: string;
  depth: number;
  expandedDirectories: Set<string>;
  expandedFiles: Set<string>;
  loadingBranches: Set<string>;
  graphForFile: (filePath: string) => CodeMapGraphResponse | undefined;
  onToggleDirectory: (key: string) => void;
  onToggleFile: (node: GraphNodeData) => void;
  onSelectFile: (node: GraphNodeData) => void;
  onOpenFile: (node: GraphNodeData) => void;
  onSelectSymbol: (node: GraphNodeData) => void;
  selectedId: string | null;
  activeFileNorms: Set<string>;
  activeSymbolIds: Set<string>;
  revealAllKeys: Set<string>;
  onRevealAll: (key: string) => void;
}

function filePathIsLive(filePath: string | undefined, activeFileNorms: Set<string>): boolean {
  if (!filePath || activeFileNorms.size === 0) return false;
  const nodeNorm = normalizedPath(filePath);
  if (activeFileNorms.has(nodeNorm)) return true;
  for (const active of activeFileNorms) {
    if (active.endsWith(`/${nodeNorm}`) || nodeNorm.endsWith(`/${active}`)) return true;
  }
  return false;
}

export const DirectoryBranch = memo(function DirectoryBranch(
  props: DirectoryBranchProps,
): React.ReactElement {
  const { t } = useAppTranslation();
  const {
    directory,
    packageName,
    depth,
    expandedDirectories,
    expandedFiles,
    loadingBranches,
    graphForFile,
    onToggleDirectory,
    onToggleFile,
    onSelectFile,
    onOpenFile,
    onSelectSymbol,
    selectedId,
    activeFileNorms,
    activeSymbolIds,
    revealAllKeys,
    onRevealAll,
  } = props;
  const filesRevealKey = `files:${packageName}:${directory.path || '.'}`;
  const showAllFiles = revealAllKeys.has(filesRevealKey);
  const visibleFiles = showAllFiles
    ? directory.files
    : directory.files.slice(0, MAX_TREE_FILES_VISIBLE);
  const hiddenFileCount = directory.files.length - visibleFiles.length;

  return (
    <>
      {directory.directories.map((child) => {
        const key = `${packageName}:${child.path}`;
        const expanded = expandedDirectories.has(key);
        return (
          <div key={key}>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onToggleDirectory(key)}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {expanded ? (
                <FolderOpen className="h-3.5 w-3.5 text-warning" />
              ) : (
                <Folder className="h-3.5 w-3.5 text-warning" />
              )}
              <span className="truncate">{child.name}</span>
            </button>
            {expanded && <DirectoryBranch {...props} directory={child} depth={depth + 1} />}
          </div>
        );
      })}
      {visibleFiles.map((file) => {
        const expanded = expandedFiles.has(file.file ?? file.id);
        const branchKey = scopeKey({ level: 'symbols', file: file.file ?? file.label });
        const symbolGraph = file.file ? graphForFile(file.file) : undefined;
        const symbols =
          symbolGraph?.nodes.filter(
            (node) => node.kind === 'symbol' && node.file === file.file && !node.external,
          ) ?? [];
        const symbolsRevealKey = `symbols:${file.file ?? file.id}`;
        const showAllSymbols = revealAllKeys.has(symbolsRevealKey);
        const visibleSymbols = showAllSymbols
          ? symbols
          : symbols.slice(0, MAX_TREE_SYMBOLS_VISIBLE);
        const hiddenSymbolCount = symbols.length - visibleSymbols.length;
        const fileLive = filePathIsLive(file.file, activeFileNorms);
        return (
          <div key={file.id}>
            <div
              className={cn(
                'group flex h-7 items-center pr-1 text-[11px] hover:bg-muted',
                selectedId === file.id && 'bg-primary/10 text-primary',
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              <button
                type="button"
                className="flex h-6 w-4 shrink-0 items-center justify-center text-muted-foreground"
                onClick={() => onToggleFile(file)}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${file.label}`}
              >
                {loadingBranches.has(branchKey) ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : expanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => onSelectFile(file)}
                onDoubleClick={() => onOpenFile(file)}
              >
                <FileCode className="h-3.5 w-3.5 shrink-0 text-info" />
                {fileLive && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 animate-pulse bg-success"
                    title={t('activity:codeMap.liveOperation')}
                  />
                )}
                <span className="truncate font-mono" title={file.file}>
                  {file.label}
                </span>
                <span className="ml-auto text-[9px] text-muted-foreground">
                  {file.symbolCount ?? 0}
                </span>
              </button>
              <button
                type="button"
                className="ml-1 hidden h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground group-hover:flex"
                onClick={() => onOpenFile(file)}
                title={t('activity:codeMap.openSymbolMap')}
                aria-label={`Open ${file.label} map`}
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
            {expanded &&
              visibleSymbols.map((symbol) => (
                <button
                  type="button"
                  key={symbol.id}
                  className={cn(
                    'flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[10px] hover:bg-muted',
                    selectedId === symbol.id
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground',
                  )}
                  style={{ paddingLeft: 38 + depth * 12 }}
                  onClick={() => onSelectSymbol(symbol)}
                >
                  <Box className="h-3 w-3 shrink-0 text-success" />
                  {activeSymbolIds.has(symbol.id) && (
                    <Radio className="h-3 w-3 shrink-0 animate-pulse text-success" />
                  )}
                  <span className="truncate font-mono">{symbol.label}</span>
                  {symbol.line && (
                    <span className="ml-auto font-mono text-[8px] opacity-60">:{symbol.line}</span>
                  )}
                </button>
              ))}
            {expanded && hiddenSymbolCount > 0 && (
              <button
                type="button"
                className="flex h-7 w-full items-center text-left font-mono text-[9px] text-primary hover:bg-muted"
                style={{ paddingLeft: 38 + depth * 12 }}
                onClick={() => onRevealAll(symbolsRevealKey)}
              >
                Show {hiddenSymbolCount} more symbols
              </button>
            )}
          </div>
        );
      })}
      {hiddenFileCount > 0 && (
        <button
          type="button"
          className="flex h-7 w-full items-center text-left font-mono text-[9px] text-primary hover:bg-muted"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => onRevealAll(filesRevealKey)}
        >
          Show {hiddenFileCount} more files
        </button>
      )}
    </>
  );
});

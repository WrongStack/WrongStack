import { ChevronDown, ChevronRight, ExternalLink, Loader2, Package, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CodeMapSearchResultRow } from './CodeMapSearchResults';
import { DirectoryBranch } from './CodeMapDirectoryTree';
import { useAppTranslation } from '@/i18n';
import {
  buildDirectoryTree,
  scopeKey,
  type CodeMapGraphResponse,
  type CodeMapScope,
  type GraphNodeData,
} from './codemap-model';

interface SearchVirtualizer {
  getTotalSize(): number;
  getVirtualItems(): Array<{ index: number; start: number }>;
  measureElement: (element: Element | null) => void;
}

interface CodeMapTreeSidebarProps {
  rootGraph: CodeMapGraphResponse;
  search: string;
  searchInput: string;
  searchResults: GraphNodeData[];
  virtualizeSearch: boolean;
  searchVirtualizer: SearchVirtualizer;
  treeScrollRef: React.RefObject<HTMLDivElement | null>;
  selectedId: string | null;
  expandedPackages: Set<string>;
  expandedDirectories: Set<string>;
  expandedFiles: Set<string>;
  loadingBranches: Set<string>;
  activeFileNorms: Set<string>;
  activeSymbolIds: Set<string>;
  revealAllKeys: Set<string>;
  packageGraph: (packageName: string) => CodeMapGraphResponse | undefined;
  graphForFile: (filePath: string) => CodeMapGraphResponse | undefined;
  navigate: (nextScope: CodeMapScope, preferredSelection?: string) => void;
  togglePackage: (node: GraphNodeData) => void;
  toggleDirectory: (key: string) => void;
  toggleFile: (node: GraphNodeData) => void;
  revealAllTree: (key: string) => void;
  selectFileFromTree: (node: GraphNodeData) => void;
  selectSymbolFromTree: (node: GraphNodeData) => void;
  selectSearchResult: (node: GraphNodeData) => void;
  handleOpenNode: (node: GraphNodeData) => void;
  onSearchInputChange: (value: string) => void;
  onSearchChange: (value: string) => void;
}

export function CodeMapTreeSidebar({
  rootGraph,
  search,
  searchInput,
  searchResults,
  virtualizeSearch,
  searchVirtualizer,
  treeScrollRef,
  selectedId,
  expandedPackages,
  expandedDirectories,
  expandedFiles,
  loadingBranches,
  activeFileNorms,
  activeSymbolIds,
  revealAllKeys,
  packageGraph,
  graphForFile,
  navigate,
  togglePackage,
  toggleDirectory,
  toggleFile,
  revealAllTree,
  selectFileFromTree,
  selectSymbolFromTree,
  selectSearchResult,
  handleOpenNode,
  onSearchInputChange,
  onSearchChange,
}: CodeMapTreeSidebarProps): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <aside className="flex w-[286px] shrink-0 flex-col border-r bg-card/70">
      <div className="border-b p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.18em]">
            {t('activity:codeMapTree.codeTree')}
          </h2>
          <span className="font-mono text-[9px] text-muted-foreground">
            {rootGraph.nodes.length} roots
          </span>
        </div>
        <label className="flex h-8 items-center gap-2 border bg-background px-2 focus-within:border-primary">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent font-mono text-[10px] outline-none placeholder:text-muted-foreground"
            value={searchInput}
            onChange={(event) => onSearchInputChange(event.target.value)}
            placeholder={t('activity:codeMapTree.findPackageFileSymbol')}
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => {
                onSearchInputChange('');
                onSearchChange('');
              }}
              aria-label={t('activity:codeMapTree.clearSearch')}
            >
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          )}
        </label>
      </div>
      <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
        {search.trim() ? (
          <div>
            <div className="px-3 pb-2 text-[9px] text-muted-foreground">
              {searchResults.length} loaded-map results
            </div>
            {searchResults.length === 0 ? (
              <p className="px-3 py-8 text-center text-[10px] text-muted-foreground">
                {t('activity:codeMapTree.noMatchInLoadedBranches')}
                <br />
                {t('activity:codeMapTree.expandAPackageToSearchIts')}
              </p>
            ) : virtualizeSearch ? (
              <div
                style={{
                  height: `${searchVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {searchVirtualizer.getVirtualItems().map((virtualRow) => {
                  const node = searchResults[virtualRow.index];
                  if (!node) return null;
                  return (
                    <CodeMapSearchResultRow
                      key={node.id}
                      node={node}
                      onSelect={selectSearchResult}
                      virtual={{
                        index: virtualRow.index,
                        start: virtualRow.start,
                        measureElement: searchVirtualizer.measureElement,
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              searchResults.map((node) => (
                <CodeMapSearchResultRow key={node.id} node={node} onSelect={selectSearchResult} />
              ))
            )}
          </div>
        ) : (
          rootGraph.nodes.map((packageNode) => {
            const packageName = packageNode.package ?? packageNode.label;
            const expanded = expandedPackages.has(packageName);
            const branchKey = scopeKey({ level: 'files', package: packageName });
            const filesGraph = packageGraph(packageName);
            const tree = filesGraph ? buildDirectoryTree(filesGraph.nodes) : undefined;
            return (
              <div key={packageNode.id}>
                <div
                  className={cn(
                    'group flex h-8 items-center px-2 hover:bg-muted',
                    selectedId === packageNode.id && 'bg-primary/10 text-primary',
                  )}
                >
                  <button
                    type="button"
                    className="flex h-6 w-5 items-center justify-center text-muted-foreground"
                    onClick={() => togglePackage(packageNode)}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${packageName}`}
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
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => navigate({ level: 'packages' }, packageNode.id)}
                    onDoubleClick={() => navigate({ level: 'files', package: packageName })}
                  >
                    <Package className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="truncate font-mono text-[10px] font-semibold">
                      {packageNode.label}
                    </span>
                    <span className="ml-auto text-[9px] text-muted-foreground">
                      {packageNode.fileCount ?? 0}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ml-1 hidden h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground group-hover:flex"
                    onClick={() => navigate({ level: 'files', package: packageName })}
                    title={t('activity:codeMapTree.openFileMap')}
                    aria-label={`Open ${packageName} map`}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </div>
                {expanded && tree && (
                  <DirectoryBranch
                    directory={tree}
                    packageName={packageName}
                    depth={1}
                    expandedDirectories={expandedDirectories}
                    expandedFiles={expandedFiles}
                    loadingBranches={loadingBranches}
                    graphForFile={graphForFile}
                    onToggleDirectory={toggleDirectory}
                    onToggleFile={toggleFile}
                    onSelectFile={selectFileFromTree}
                    onOpenFile={handleOpenNode}
                    onSelectSymbol={selectSymbolFromTree}
                    selectedId={selectedId}
                    activeFileNorms={activeFileNorms}
                    activeSymbolIds={activeSymbolIds}
                    revealAllKeys={revealAllKeys}
                    onRevealAll={revealAllTree}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="border-t px-3 py-2 text-[9px] leading-relaxed text-muted-foreground">
        {t('activity:codeMapTree.clickToFocusDoubleClickTo')}
        <br />
        {t('activity:codeMapTree.branchesStayOpenWhileTheMap')}
      </div>
    </aside>
  );
}

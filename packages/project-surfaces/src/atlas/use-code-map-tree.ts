import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useState } from 'react';
import { SEARCH_VIRTUALIZE_THRESHOLD } from './CodeMapConfig';
import {
  buildDirectoryTree,
  type CodeMapGraphResponse,
  type CodeMapScope,
  type GraphNodeData,
  scopeKey,
} from './codemap-model';

/**
 * Code Atlas explorer state: package/directory/file expansion (lazily loading
 * branches), "show all" reveals, tree selection, and the cross-cache search
 * with its virtualized result list.
 */
export function useCodeMapTree({
  cache,
  cacheRevision,
  ensureBranch,
  navigate,
  search,
  treeScrollRef,
}: {
  cache: React.MutableRefObject<Map<string, CodeMapGraphResponse>>;
  cacheRevision: number;
  ensureBranch: (targetScope: CodeMapScope) => Promise<void>;
  navigate: (nextScope: CodeMapScope, preferredSelection?: string) => void;
  search: string;
  treeScrollRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const [expandedPackages, setExpandedPackages] = useState<Set<string>>(new Set());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [revealAllKeys, setRevealAllKeys] = useState<Set<string>>(new Set());

  const togglePackage = useCallback(
    (node: GraphNodeData): void => {
      const packageName = node.package ?? node.label;
      const opening = !expandedPackages.has(packageName);
      setExpandedPackages((current) => {
        const next = new Set(current);
        opening ? next.add(packageName) : next.delete(packageName);
        return next;
      });
      if (opening) {
        void ensureBranch({ level: 'files', package: packageName })
          .then(() => {
            const branch = cache.current.get(scopeKey({ level: 'files', package: packageName }));
            const tree = branch ? buildDirectoryTree(branch.nodes) : undefined;
            if (tree?.directories.length === 1 && tree.directories[0]) {
              setExpandedDirectories((current) =>
                new Set(current).add(`${packageName}:${tree.directories[0]!.path}`),
              );
            }
          })
          .catch(() => undefined);
      }
    },
    [ensureBranch, expandedPackages],
  );

  const toggleFile = useCallback(
    (node: GraphNodeData): void => {
      if (!node.file) return;
      const opening = !expandedFiles.has(node.file);
      setExpandedFiles((current) => {
        const next = new Set(current);
        opening ? next.add(node.file!) : next.delete(node.file!);
        return next;
      });
      if (opening)
        void ensureBranch({ level: 'symbols', file: node.file, package: node.package }).catch(
          () => undefined,
        );
    },
    [ensureBranch, expandedFiles],
  );

  const toggleDirectory = useCallback((key: string): void => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const revealAllTree = useCallback((key: string): void => {
    setRevealAllKeys((current) => new Set(current).add(key));
  }, []);

  const selectFileFromTree = useCallback(
    (node: GraphNodeData): void => {
      navigate({ level: 'files', package: node.package ?? '(root)' }, node.id);
    },
    [navigate],
  );
  const selectSymbolFromTree = useCallback(
    (node: GraphNodeData): void => {
      if (node.file)
        navigate({ level: 'symbols', file: node.file, package: node.package }, node.id);
    },
    [navigate],
  );

  const searchResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return [];
    const unique = new Map<string, GraphNodeData>();
    for (const cachedGraph of cache.current.values()) {
      for (const node of cachedGraph.nodes) {
        const haystack =
          `${node.label} ${node.file ?? ''} ${node.signature ?? ''} ${node.package ?? ''}`.toLocaleLowerCase();
        if (haystack.includes(query)) unique.set(node.id, node);
      }
    }
    return [...unique.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
      .slice(0, 80);
  }, [search, cacheRevision]);

  const virtualizeSearch = searchResults.length > SEARCH_VIRTUALIZE_THRESHOLD;
  const searchVirtualizer = useVirtualizer({
    count: searchResults.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: () => 40,
    overscan: 8,
    enabled: virtualizeSearch,
  });

  const selectSearchResult = useCallback(
    (node: GraphNodeData): void => {
      if (node.kind === 'package') navigate({ level: 'packages' }, node.id);
      else if (node.kind === 'file')
        navigate({ level: 'files', package: node.package ?? '(root)' }, node.id);
      else if (node.file)
        navigate({ level: 'symbols', file: node.file, package: node.package }, node.id);
    },
    [navigate],
  );

  return {
    expandedPackages,
    expandedDirectories,
    expandedFiles,
    revealAllKeys,
    togglePackage,
    toggleFile,
    toggleDirectory,
    revealAllTree,
    selectFileFromTree,
    selectSymbolFromTree,
    searchResults,
    virtualizeSearch,
    searchVirtualizer,
    selectSearchResult,
  };
}

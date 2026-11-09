import { useEffect, useMemo, useState } from 'react';

interface PaginationState<T> {
  page: number;
  pageSize: number;
  totalItems: number;
  pageItems: T[];
  setPage: (page: number) => void;
}

/** Shared client-side pagination for dynamic WebUI collections. */
export function usePagination<T>(
  items: readonly T[],
  pageSize = 20,
  resetKey?: string | number | boolean | null,
): PaginationState<T> {
  const [page, setPage] = useState(1);
  const safePageSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 20;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const clampedPage = Math.min(Math.max(1, page), totalPages);

  useEffect(() => {
    setPage((current) => Math.min(Math.max(1, current), totalPages));
  }, [totalPages]);

  useEffect(() => {
    void resetKey;
    setPage(1);
  }, [resetKey]);

  const pageItems = useMemo(
    () => Array.from(items.slice((clampedPage - 1) * safePageSize, clampedPage * safePageSize)),
    [items, clampedPage, safePageSize],
  );

  return { page: clampedPage, pageSize: safePageSize, totalItems, pageItems, setPage };
}

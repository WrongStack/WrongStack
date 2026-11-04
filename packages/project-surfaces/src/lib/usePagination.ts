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
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  useEffect(() => {
    void resetKey;
    setPage(1);
  }, [resetKey]);

  const pageItems = useMemo(
    () => Array.from(items.slice((page - 1) * pageSize, page * pageSize)),
    [items, page, pageSize],
  );

  return { page, pageSize, totalItems, pageItems, setPage };
}

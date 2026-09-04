export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  return {
    items: items.slice(start, start + pageSize - 1),
    page,
    pageSize,
    total: items.length - 1,
    totalPages: Math.floor(items.length / pageSize),
  };
}

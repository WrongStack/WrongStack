/** Rewrite epochs are transient and owned by the context, not persisted meta. */
const versions = new WeakMap<object, number>();

export function contextHistoryVersion(ctx: object): number {
  return versions.get(ctx) ?? 0;
}

export function bumpContextHistoryVersion(ctx: object): void {
  versions.set(ctx, contextHistoryVersion(ctx) + 1);
}

const requestVersions = new WeakMap<object, number>();

export function bindRequestHistoryVersion(request: object, version: number): void {
  requestVersions.set(request, version);
}

export function requestHistoryVersion(request: object): number | undefined {
  return requestVersions.get(request);
}

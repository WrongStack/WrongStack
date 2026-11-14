/**
 * This application's version, as the native side reports it (`host_info`). Engine notices
 * compare against it: an engine older than the application needs a restart, not an update.
 */
let known: string | undefined;

export function setDesktopVersion(version: string | undefined): void {
  known = version?.trim() || undefined;
}

export function desktopVersion(): string | undefined {
  return known;
}

/** Whether release `a` (`1.7.1` or `v1.7.1`) is at least `b`; false for anything unparsable. */
export function versionAtLeast(a: string, b: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return true;
}

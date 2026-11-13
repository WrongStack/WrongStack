/**
 * List all changed files in the working tree (porcelain status).
 * Includes both tracked modifications and untracked additions.
 *
 * Uses NUL-delimited porcelain output so Git returns raw path bytes instead of
 * C-style quoted/escaped names. Rename and copy entries contain an additional
 * source-path record; the first record is the destination path we review.
 */
export function parsePorcelainStatusZ(stdout: string): Array<{ path: string; status: string }> {
  const records = stdout.split('\0');
  const out: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const statusCode = record.slice(0, 2).trim();
    const filePath = record.slice(3);
    if (filePath) out.push({ path: filePath, status: statusCode });
    if (statusCode.includes('R') || statusCode.includes('C')) index++;
  }
  return out;
}

/**
 * Porcelain status paths are relative to the repository root whatever the
 * cwd. Keep the entries under `prefix` (`git rev-parse --show-prefix` of the
 * cwd) and make them cwd-relative, so a project opened in a repository
 * subdirectory reads its own files instead of `<cwd>/<prefix>/<file>`.
 */
export function statusUnderPrefix(
  stdout: string,
  prefix: string,
): Array<{ path: string; status: string }> {
  return parsePorcelainStatusZ(stdout)
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
}

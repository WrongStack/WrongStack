import path from 'node:path';

function normalizeFile(repoRoot, file) {
  // Vitest on Windows emits absolute paths with backslash separators (e.g.
  // `C:\repo\packages\core\tests\a.test.ts`). This function must normalize
  // them to POSIX relative paths regardless of the platform running the
  // check (CI runs on Linux but may parse Windows-origin vitest output).
  const normalizedFile = file.replace(/\\/g, '/');
  const normalizedRoot = repoRoot.replace(/\\/g, '/');
  const absolute = path.isAbsolute(normalizedFile)
    ? normalizedFile
    : path.posix.resolve(normalizedRoot, normalizedFile);
  return path.posix.relative(normalizedRoot, absolute);
}

export function parseVitestFileList(repoRoot, stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Vitest returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(rows)) throw new Error('Vitest file list must be a JSON array');

  const files = rows.map((row) => {
    const file = typeof row === 'string' ? row : row?.file;
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('Vitest file list contains an entry without a file path');
    }
    return normalizeFile(repoRoot, file);
  });
  return [...new Set(files)].sort();
}

export function validateRuntimeTestInventory(runtimeAssignments, collectedByProject, projectIds) {
  const errors = [];
  const expectedByProject = new Map(projectIds.map((id) => [id, new Set()]));

  for (const assignment of runtimeAssignments) {
    if (assignment.projects.length !== 1) continue;
    const expected = expectedByProject.get(assignment.projects[0]);
    if (!expected) {
      errors.push(
        `${assignment.file}: assigned to unknown runtime project ${assignment.projects[0]}`,
      );
      continue;
    }
    expected.add(assignment.file);
  }

  const rows = [];
  for (const projectId of projectIds) {
    const expected = expectedByProject.get(projectId);
    const collected = new Set(collectedByProject.get(projectId) ?? []);
    const missing = [...expected].filter((file) => !collected.has(file)).sort();
    const unexpected = [...collected].filter((file) => !expected.has(file)).sort();

    if (collected.size === 0) errors.push(`${projectId}: Vitest collected zero test files`);
    if (missing.length > 0)
      errors.push(
        `${projectId}: ${missing.length} expected test file(s) were not collected: ${missing.join(', ')}`,
      );
    if (unexpected.length > 0)
      errors.push(
        `${projectId}: ${unexpected.length} unexpected test file(s) were collected: ${unexpected.join(', ')}`,
      );

    rows.push({
      projectId,
      expected: expected.size,
      collected: collected.size,
      missing,
      unexpected,
    });
  }

  const collectedOwners = new Map();
  for (const [projectId, files] of collectedByProject) {
    for (const file of files) {
      const owners = collectedOwners.get(file) ?? [];
      owners.push(projectId);
      collectedOwners.set(file, owners);
    }
  }
  for (const [file, owners] of collectedOwners) {
    if (owners.length > 1)
      errors.push(`${file}: collected by multiple runtime projects: ${owners.sort().join(', ')}`);
  }

  return { errors, projects: rows };
}

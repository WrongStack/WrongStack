const fs = require('node:fs');
const c = require('../kanban-coverage.json');
const sourceFiles = {};

for (const [k, v] of Object.entries(c.coverageMap)) {
  const rel = k.replace(/\\/g, '/').replace(/^.*\/packages\/kanban\/src\//, '');
  sourceFiles[rel] = { v, source: fs.readFileSync(k, 'utf8') };
}

// For each source file, find functions in source and check coverage
for (const [rel, { v, source }] of Object.entries(sourceFiles)) {
  console.log(`\n=== ${rel} ===`);

  const lines = source.split('\n');
  const stmtTotal = Object.keys(v.statementMap).length;
  const stmtHit = Object.keys(v.statementMap).filter((i) => v.s[i] && v.s[i] > 0).length;
  const branchTotal = Object.keys(v.branchMap || {}).length;
  const branchHits = Object.keys(v.branchMap || {}).filter((i) => {
    const bh = v.b[i] || {};
    return Object.values(bh).some((x) => x > 0);
  }).length;
  const fnTotal = Object.keys(v.fnMap || {}).length;
  const fnHits = Object.keys(v.fnMap || {}).filter((i) => v.f[i] && v.f[i] > 0).length;

  console.log(
    `  Coverage: stmts ${stmtHit}/${stmtTotal}, branches ${branchHits}/${branchTotal}, funcs ${fnHits}/${fnTotal}`,
  );

  // Show uncovered functions
  if (v.fnMap) {
    const uncoveredFns = Object.keys(v.fnMap).filter((i) => !v.f[i] || v.f[i] === 0);
    if (uncoveredFns.length) {
      console.log('\n  UNCOVERED FUNCTIONS:');
      for (const fi of uncoveredFns) {
        const fn = v.fnMap[fi];
        console.log(`    L${fn.line}: ${fn.name}`);
      }
    }
  }

  // Show uncovered branches with line context
  if (v.branchMap) {
    const uncoveredBranches = Object.keys(v.branchMap).filter((i) => {
      const bh = v.b[i] || {};
      return Object.values(bh).every((x) => x === 0);
    });
    if (uncoveredBranches.length) {
      console.log('\n  UNCOVERED BRANCHES:');
      for (const bi of uncoveredBranches.slice(0, 50)) {
        const b = v.branchMap[bi];
        const contextLine = lines[b.line - 1] || '';
        console.log(`    L${b.line}: ${contextLine.trim()}`);
      }
      if (uncoveredBranches.length > 50) {
        console.log(`    ... and ${uncoveredBranches.length - 50} more`);
      }
    }
  }
}

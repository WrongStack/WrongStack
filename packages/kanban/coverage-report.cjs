const c = require('./kanban-coverage.json');
for (const [k, v] of Object.entries(c.coverageMap)) {
  const path = k.replace(/\\/g, '/').split('/').slice(-3).join('/');
  const uncovered = Object.keys(v.statementMap).filter((i) => !v.s[i] || v.s[i] === 0);
  const branches = Object.keys(v.branchMap || {}).filter((i) => {
    const branchHits = v.b[i] || {};
    return Object.values(branchHits).every((x) => x === 0);
  });
  const fns = Object.keys(v.fnMap || {}).filter((i) => !v.f[i] || v.f[i] === 0);
  console.log(path);
  if (uncovered.length) {
    console.log(
      '  uncovered stmts:',
      uncovered
        .map((s) => {
          const stmt = v.statementMap[s];
          return `L${stmt.start.line}:${stmt.start.column}-L${stmt.end.line}:${stmt.end.column}`;
        })
        .join('\n    '),
    );
  }
  if (branches.length) {
    console.log(
      '  uncovered branches at lines:',
      branches.map((b) => v.branchMap[b].line).join(', '),
    );
  }
  if (fns.length) {
    console.log('  uncovered fns:', fns.map((f) => v.fnMap[f].name).join(', '));
  }
  if (!uncovered.length && !branches.length && !fns.length) console.log('  100% covered');
}

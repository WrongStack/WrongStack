import { expect, it } from 'vitest';
import { parseInfraArtifact } from '../src/codebase-index/infra-parser.js';

// F1347: the Makefile branch matched the untrimmed line, so in a CRLF file the
// trailing CR made every target WITH prerequisites fail `(.*)$` — the target and
// its prerequisite edges vanished. GNU make reads CRLF Makefiles normally.
it('indexes the same Makefile targets and prerequisites for CRLF as for LF (F1347)', () => {
  const lf = 'all: build\nbuild: compile\n\t@echo built\ncompile:\n\t@echo compiled\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const view = (content: string) => {
    const res = parseInfraArtifact({ file: 'Makefile', content });
    return {
      targets: res.symbols.map((s) => [s.name, s.line, s.signature]),
      prereqs: res.refs.map((r) => [r.toName, r.line]),
    };
  };
  expect(view(crlf)).toEqual(view(lf));
  expect(view(crlf).targets.map(([name]) => name)).toEqual(['all', 'build', 'compile']);
  expect(view(crlf).prereqs).toEqual([
    ['build', 1],
    ['compile', 2],
  ]);
});

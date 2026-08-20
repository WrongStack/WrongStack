/**
 * Mutation-testing fixture — intentionally trivial production code.
 * The `mutation_test` tool plans deterministic mutants against this file:
 * `arith-plus-to-minus` on line 2 and `return-null` on line 2.
 * Not a test file; vitest only collects `*.test.ts`.
 */
export function add(a: number, b: number): number {
  return a + b;
}

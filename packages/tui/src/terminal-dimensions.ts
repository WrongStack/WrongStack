/** Terminal dimensions are whole, positive cell counts. Hidden or detached
 * hosts can temporarily report zero or non-finite values during resize. */
export function terminalDimension(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

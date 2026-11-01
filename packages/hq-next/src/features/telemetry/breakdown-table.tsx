import type { ReactNode } from 'react';
import { type BreakdownRow, count, percent, usd } from './model';

/** Spend split by model or provider, with the share written out as well as drawn. */
export function BreakdownTable({
  title,
  rows,
  showTokens,
}: {
  title: string;
  rows: readonly BreakdownRow[];
  showTokens: boolean;
}): ReactNode {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1.5 font-medium">Name</th>
              {showTokens && <th className="py-1.5 text-right font-medium">Tokens in / out</th>}
              {showTokens && <th className="py-1.5 text-right font-medium">Cache</th>}
              <th className="py-1.5 text-right font-medium">Cost</th>
              <th className="w-40 py-1.5 pl-4 font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border">
                <td className="py-2 font-medium">{row.key}</td>
                {showTokens && (
                  <td className="tabular py-2 text-right text-muted-foreground">
                    {count(row.inputTokens)} / {count(row.outputTokens)}
                  </td>
                )}
                {showTokens && (
                  <td className="tabular py-2 text-right text-muted-foreground">
                    {row.cacheTokens > 0 ? count(row.cacheTokens) : '—'}
                  </td>
                )}
                <td className="tabular py-2 text-right font-semibold">{usd(row.costUsd)}</td>
                <td className="py-2 pl-4">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 flex-1 bg-muted">
                      <span
                        className="block h-full bg-primary"
                        style={{ width: `${Math.max(row.share * 100, row.share > 0 ? 1 : 0)}%` }}
                      />
                    </span>
                    <span className="tabular w-10 text-right text-muted-foreground">
                      {percent(row.share)}
                    </span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

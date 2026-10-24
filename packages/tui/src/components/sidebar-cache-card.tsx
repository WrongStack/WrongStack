import type { CacheStats } from '@wrongstack/contracts/types';
import type React from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { Card } from './sidebar-card.js';
import { SidebarSectionHeader } from './sidebar-panel-frame.js';
import { fmtRatioPct, fmtTok, renderMeter } from './status-bar-format.js';

/** Sidebar prompt-cache card: last-request hit ratio, session average and coverage. */
export function CacheCard({
  cacheStats,
  innerWidth,
}: {
  cacheStats: CacheStats | undefined;
  innerWidth: number;
}): React.ReactElement {
  // Cache summary — the badge and meter show the LAST request (`cs.last`);
  // `hitRatio` is the cumulative session figure, which carries the cold first
  // request forever and lags every change, so it is only the secondary
  // "session" line. The card stays visible with a "no cache yet" hint so
  // users learn about the metric instead of wondering where it went.
  const cs = cacheStats ?? { readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 };
  const hasCacheActivity = cs.readTokens > 0 || cs.writeTokens > 0;
  const lastHitRatio = cs.last?.hitRatio ?? cs.hitRatio;
  const cacheHitPct = fmtRatioPct(lastHitRatio);
  return (
    <Card innerWidth={innerWidth} accent={hasCacheActivity ? theme.success : undefined}>
      {(bodyWidth) => {
        const meterInner = Math.max(1, bodyWidth - 2);
        const dynamicMeter = renderMeter(lastHitRatio, meterInner);
        return (
          <>
            <SidebarSectionHeader
              glyph={glyphs.context}
              label="PROMPT CACHE"
              color={hasCacheActivity ? theme.success : theme.textMuted}
              badge={hasCacheActivity ? `${cacheHitPct} HIT` : 'IDLE'}
              badgeColor={hasCacheActivity ? theme.success : theme.textMuted}
              innerWidth={bodyWidth}
              pill
              badgeMuted={!hasCacheActivity}
            />
            {hasCacheActivity ? (
              <>
                <Box width={bodyWidth} flexDirection="row">
                  <Text color={theme.success}>{dynamicMeter}</Text>
                </Box>
                {cs.last ? (
                  <Text color={theme.textSecondary} wrap="truncate">
                    last{' '}
                    <Text color={theme.textPrimary} bold>
                      {cacheHitPct}
                    </Text>
                    {' · '}avg {fmtRatioPct(cs.hitRatio)}
                  </Text>
                ) : null}
                {bodyWidth >= 28 ? (
                  <Box flexDirection="row" width={bodyWidth} justifyContent="space-between">
                    <Text color={theme.textSecondary} wrap="truncate">
                      read{' '}
                      <Text color={theme.textPrimary} bold>
                        {fmtTok(cs.readTokens)}
                      </Text>
                      {cs.writeTokens > 0 ? (
                        <>
                          {' · '}write{' '}
                          <Text color={theme.textPrimary} bold>
                            {fmtTok(cs.writeTokens)}
                          </Text>
                        </>
                      ) : null}
                      {cs.savedUsd > 0 ? (
                        <>
                          {' · '}saved{' '}
                          <Text color={theme.success} bold>
                            ~${cs.savedUsd.toFixed(2)}
                          </Text>
                        </>
                      ) : null}
                    </Text>
                  </Box>
                ) : (
                  <>
                    <Box flexDirection="row" width={bodyWidth} justifyContent="space-between">
                      <Text color={theme.textSecondary} wrap="truncate">
                        read{' '}
                        <Text color={theme.textPrimary} bold>
                          {fmtTok(cs.readTokens)}
                        </Text>
                      </Text>
                      {cs.writeTokens > 0 ? (
                        <Text color={theme.textSecondary} wrap="truncate">
                          write{' '}
                          <Text color={theme.textPrimary} bold>
                            {fmtTok(cs.writeTokens)}
                          </Text>
                        </Text>
                      ) : null}
                    </Box>
                    {cs.savedUsd > 0 ? (
                      <Box flexDirection="row" width={bodyWidth} justifyContent="space-between">
                        <Text color={theme.textSecondary} wrap="truncate">
                          saved
                        </Text>
                        <Text color={theme.success} bold wrap="truncate">
                          ~${cs.savedUsd.toFixed(2)}
                        </Text>
                      </Box>
                    ) : null}
                  </>
                )}
              </>
            ) : (
              <Text color={theme.textMuted} wrap="truncate">
                {glyphs.dividerDot} standby · caches prefix on prompt
              </Text>
            )}
          </>
        );
      }}
    </Card>
  );
}

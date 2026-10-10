/* =========================================================================
   Changelog — historical entries mirror CHANGELOG.md release notes; the
   1.0.37 entry was written from committed runtime/source evidence (git
   history and packages). Each entry has version, date, tagline, and key
   highlights. Historical entries are split across part modules to keep
   every hand-maintained file small; this module restores the single
   ordered catalog that src/lib/utils.ts re-exports.
   ========================================================================= */

import { changelog0xRecent } from './changelog-0x-a';
import { changelog0xEarly } from './changelog-0x-b';
import { changelog1x } from './changelog-1x';
import type { ChangelogEntry } from './changelog-types';

export type { ChangelogEntry } from './changelog-types';

// Pure catalog assembly lets unused release history stay out of the startup bundle.
export const changelog: ChangelogEntry[] = /* @__PURE__ */ changelog1x.concat(
  changelog0xRecent,
  changelog0xEarly,
);

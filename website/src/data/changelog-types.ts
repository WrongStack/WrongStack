/** Changelog entry shape, shared by every changelog part module. */
export interface ChangelogEntry {
  version: string;
  date: string;
  tagline: string;
  highlights: string[];
  /** If true, this release consolidated intermediate bump-only versions. */
  consolidated?: boolean;
  /** If true, marks the latest release. */
  latest?: boolean;
}

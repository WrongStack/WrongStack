/**
 * Self-update of the standalone executable. The npm install updates through
 * its package manager and only ever shows a notice.
 *
 * User config only: a repo-committed config is denied this section, since it
 * decides what runs as the user's executable.
 */
export interface UpdateConfig {
  /**
   * Download a newer release in the background, verify it, and swap it in
   * when the session exits, so the next start runs it. Default: true.
   * `WRONGSTACK_NO_AUTO_UPDATE=1` also turns it off.
   */
  autoDownload?: boolean | undefined;
  /** Release stream to follow. Only `stable` is published. */
  channel?: 'stable' | undefined;
}

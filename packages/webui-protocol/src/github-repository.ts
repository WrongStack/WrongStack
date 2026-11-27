/**
 * Read-only GitHub view of the active project's `origin` repository, served by
 * `GET /api/github?sessionId=…`. Every text field is third-party content:
 * render it as plain text and never feed it to an agent unquoted.
 */

export interface GitHubLabel {
  name: string;
  /** Six hex digits without '#', exactly as GitHub reports it. */
  color: string;
}

export interface GitHubItemBase {
  number: number;
  title: string;
  /** Always an `https://github.com/` URL; the server drops anything else. */
  url: string;
  author: string | null;
  labels: GitHubLabel[];
  comments: number;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullSummary extends GitHubItemBase {
  draft: boolean;
  headRef: string;
  baseRef: string;
}

export type GitHubIssueSummary = GitHubItemBase;

/**
 * Why the lists are empty when they are. `ok` means GitHub answered; the other
 * states are reported with HTTP 200 so the view can explain them.
 */
export type GitHubRepositoryStatus =
  | 'ok'
  | 'no-remote'
  | 'not-github'
  | 'needs-auth'
  | 'not-found'
  | 'rate-limited'
  | 'unavailable';

export type GitHubTokenSource = 'env' | 'gh' | 'none';

export interface GitHubRepositoryView {
  status: GitHubRepositoryStatus;
  projectRoot: string;
  /** `owner/repo`; never the raw remote URL (it can carry credentials). */
  repository: string | null;
  tokenSource: GitHubTokenSource;
  pulls: GitHubPullSummary[];
  issues: GitHubIssueSummary[];
  /** True when GitHub has more open items than the page the server read. */
  truncated: { pulls: boolean; issues: boolean };
  fetchedAt: string;
}

export type GitHubItemKind = 'pull' | 'issue';

export interface GitHubCheck {
  name: string;
  /** `queued` | `in_progress` | `completed` (commit statuses map onto these). */
  status: string;
  /** `success` | `failure` | `neutral` | `cancelled` | `skipped` | `timed_out` | … or null while running. */
  conclusion: string | null;
  /** A github.com page for the check, when GitHub gave one. */
  url: string | null;
}

export interface GitHubReview {
  author: string | null;
  /** `APPROVED` | `CHANGES_REQUESTED` | `COMMENTED` | `DISMISSED`. */
  state: string;
  submittedAt: string;
  body: string;
}

export interface GitHubPullFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /**
   * GitHub's unified hunks for the file, capped. null when GitHub sends none
   * (binary or very large files) or the pane's patch budget ran out.
   */
  patch: string | null;
  /** The patch was cut short by the server's cap. */
  patchTruncated: boolean;
}

export interface GitHubItemDetail extends GitHubItemBase {
  kind: GitHubItemKind;
  state: 'open' | 'closed';
  /** Plain text, capped; third-party content. */
  body: string;
  /** Pull requests only. */
  pull: {
    draft: boolean;
    merged: boolean;
    /** null while GitHub is still computing it. */
    mergeable: boolean | null;
    mergeableState: string;
    headRef: string;
    baseRef: string;
    /** Writes carry this back so GitHub refuses them if the branch moved. */
    headSha: string;
    /** The head branch lives in another repository. */
    fromFork: boolean;
    additions: number;
    deletions: number;
    changedFiles: number;
    /** null when that part could not be read; the rest still shows. */
    files: GitHubPullFile[] | null;
    checks: GitHubCheck[] | null;
    reviews: GitHubReview[] | null;
  } | null;
}

export interface GitHubItemDetailView {
  status: GitHubRepositoryStatus;
  repository: string | null;
  tokenSource: GitHubTokenSource;
  item: GitHubItemDetail | null;
}

export type GitHubAction =
  | 'comment'
  | 'approve'
  | 'request-changes'
  | 'merge'
  | 'close'
  | 'reopen'
  /** Re-run the failed GitHub Actions jobs on the pull request's head. */
  | 'rerun-failed';
export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase';

/** Body of `POST /api/github/action?sessionId=…`. */
export interface GitHubActionRequest {
  kind: GitHubItemKind;
  number: number;
  action: GitHubAction;
  body?: string;
  mergeMethod?: GitHubMergeMethod;
  /** Required for approve, request-changes, merge and rerun-failed. */
  expectedHeadSha?: string;
}

export interface GitHubActionResult {
  ok: boolean;
  status:
    | 'done'
    | 'nothing-to-do'
    | 'needs-auth'
    | 'not-found'
    | 'conflict'
    | 'rejected'
    | 'rate-limited'
    | 'unavailable'
    | 'no-remote'
    | 'not-github';
  /** GitHub's own explanation, capped plain text. */
  message?: string;
}

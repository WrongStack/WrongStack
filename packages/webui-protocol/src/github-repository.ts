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
  state: 'open' | 'closed';
}

export interface GitHubPullSummary extends GitHubItemBase {
  draft: boolean;
  /** Closed by a merge (GitHub reports `merged_at`). */
  merged: boolean;
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

export type GitHubListState = 'open' | 'closed' | 'all';

/**
 * One page of a list, served by `GET /api/github/list?sessionId=…&kind=…
 * &state=…&page=…` (issues also take `labels` and `assignee`). `nextPage` is
 * GitHub's next page number, null on the last one; a page can be empty while
 * more follow (the issues endpoint mixes in pull requests, which are dropped).
 * With `q`, the page comes from GitHub's search: `total` is its match count,
 * and pull requests carry no branches (`headRef`/`baseRef` are empty).
 */
export type GitHubListPage =
  | {
      status: GitHubRepositoryStatus;
      kind: 'pulls';
      items: GitHubPullSummary[];
      nextPage: number | null;
      total?: number;
    }
  | {
      status: GitHubRepositoryStatus;
      kind: 'issues';
      items: GitHubIssueSummary[];
      nextPage: number | null;
      total?: number;
    };

/** The repository's labels (one page of 100), from `GET /api/github/labels`. */
export interface GitHubLabelsView {
  status: GitHubRepositoryStatus;
  labels: GitHubLabel[];
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

/** A review comment on one line of a pull request's diff. */
export interface GitHubLineComment {
  path: string;
  /** The line on `side` in the current diff; null when the comment is outdated. */
  line: number | null;
  /** RIGHT = the new file, LEFT = the old one. */
  side: 'LEFT' | 'RIGHT';
  author: string | null;
  body: string;
  createdAt: string;
  url: string | null;
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
    /**
     * Writes carry this back: a merge, verdict or re-run is refused if the
     * branch moved since; comments are pinned to the commit the user saw.
     */
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
    lineComments: GitHubLineComment[] | null;
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
  | 'rerun-failed'
  /** A review comment on one diff line (`path`, `line`, `side`, `body`). */
  | 'line-comment'
  /** A plain review (`body` and/or `comments`) that neither approves nor requests changes. */
  | 'review';
export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase';

/** A line comment held back to be sent with a review. */
export interface GitHubReviewDraftComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

/** Body of `POST /api/github/action?sessionId=…`. */
export interface GitHubActionRequest {
  kind: GitHubItemKind;
  number: number;
  action: GitHubAction;
  body?: string;
  mergeMethod?: GitHubMergeMethod;
  /** Required for approve, request-changes, merge, rerun-failed and line-comment. */
  expectedHeadSha?: string;
  /** approve, request-changes and review: line comments sent as part of the review. */
  comments?: GitHubReviewDraftComment[];
  /** line-comment only. */
  path?: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
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

/**
 * Whether the project's current branch can become a pull request, from
 * `GET /api/github/create-context`. "Pushed" is GitHub's ref compared with the
 * local HEAD, never a local remote-tracking ref.
 */
export type GitHubBranchState =
  /** No branch checked out. */
  | 'detached'
  /** The branch is the repository's default branch. */
  | 'default'
  /** The name cannot be used as a pull request head here. */
  | 'unsupported'
  /** GitHub has no branch of that name. */
  | 'not-pushed'
  /** GitHub's branch is at another commit than the local one. */
  | 'out-of-sync'
  /** GitHub's branch is at the local commit. */
  | 'ready';

export interface GitHubCreateContext {
  status: GitHubRepositoryStatus;
  repository: string | null;
  tokenSource: GitHubTokenSource;
  defaultBranch: string | null;
  branch: {
    name: string | null;
    state: GitHubBranchState;
    /** The last commit's subject, a title suggestion. */
    subject: string;
    /** An open pull request from this branch, opened instead of a duplicate. */
    openPull: { number: number; title: string; url: string } | null;
  } | null;
}

/** `POST /api/github/create?sessionId=…`. A pull request's head is the project's current branch. */
export type GitHubCreateRequest =
  | { kind: 'issue'; title: string; body?: string }
  | {
      kind: 'pull';
      title: string;
      body?: string;
      base: string;
      draft?: boolean;
      /** The branch the form showed; refused as a conflict if another is checked out now. */
      head: string;
    };

export interface GitHubCreateResult extends GitHubActionResult {
  /** The created item, when `ok`. */
  item?: { kind: GitHubItemKind; number: number; url: string };
}

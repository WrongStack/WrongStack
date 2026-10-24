# @wrongstack/hq

The WrongStack HQ control plane: the browser-safe wire protocol
(`@wrongstack/hq/protocol`), the telemetry publisher and its factory, the
auth / exposure / bootstrap stores, persistence, and the bridges that mirror
sessions, fleets, tools, approvals, costs, worktrees and the brain to HQ.

Extracted from `@wrongstack/core` (`src/hq/`) on 2026-10-24. Core does not
depend on this package: its project mailbox talks to HQ through
`MailboxHqPublisherPort` (`@wrongstack/contracts/types/hq-mailbox-publisher`)
and resolves the factory from the container token
`HQ_MAILBOX_PUBLISHER_FACTORY`, which `@wrongstack/runtime` binds to
`createHqPublisherFromEnv`.

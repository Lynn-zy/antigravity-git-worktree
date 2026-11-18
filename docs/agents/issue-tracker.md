# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on `Lynn-zy/antigravity-git-worktree`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc or `--body-file` for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...` or `gh issue edit <parent> --add-sub-issue <child>` (`gh` 2.94+). With `gh` 2.93 or older: `gh api --method POST repos/Lynn-zy/antigravity-git-worktree/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (numeric database `id`, not `#number` or `node_id`).
- **Blocking**: GitHub's **native issue dependencies**. With `gh` 2.94+: `gh issue create --blocked-by <n>,<n> ...` or `gh issue edit <child> --add-blocked-by <blocker>`. With `gh` 2.93 or older: `gh api --method POST repos/Lynn-zy/antigravity-git-worktree/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` (where `<blocker-db-id>` is `gh api repos/Lynn-zy/antigravity-git-worktree/issues/<n> --jq .id`). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Count open blockers**: `gh api repos/Lynn-zy/antigravity-git-worktree/issues/<n> --jq .issue_dependencies_summary.blocked_by` (0 means startable), or check open entries in `dependencies/blocked_by`.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: post the explanation with `gh issue comment <number> --body "..."`, then `gh issue close <number>`.

Before the first `gh issue create` of a session, confirm `gh repo view --json nameWithOwner` resolves to `Lynn-zy/antigravity-git-worktree`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub native issue dependencies as documented above.
- **Frontier query**: list the map's open sub-issues, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

# Shared delivery workflow

Every contributor — human or agent — works in a separate checkout/worktree on a `codex/rv-NN-description` branch and integrates through a PR. Nobody pushes directly to `main`. This is the agreed workflow; repository settings and auto-merge have not been configured by these docs.

1. Read `AGENTS.md`, current project state and the relevant spec. Fetch and inspect status/history before editing; preserve unrelated changes.
2. Keep each slice scoped. Use separate files/modules where practical; coordinate ownership of shared files such as `src/main.tsx`, lockfiles and migrations.
3. Run applicable typecheck, build, tests and runtime checks. Never claim live provider success from a mock.
4. Stage only owned files. Commit with `git -c commit.gpgsign=false commit -m "[RV-NN] describe the change"`. Include related documentation and push every completed documentation update.
5. Fetch before pushing. If `main` advanced and the branch is not yet public, rebase onto it without destructive resets and re-run affected checks. Once a branch is pushed, the no-force-push rule outranks this: bring `main` in with a merge commit instead of rebasing, so a collaborator or an open PR never has history rewritten out from under it. Avoid integrating over a dirty shared checkout; preserve the other developer's work or use an isolated worktree.
6. Push the branch, open a PR, and merge it. If the branch falls behind because another PR merged meanwhile, fetch, integrate (rebase if unpushed, merge if already public), re-run checks, and push again.

Keep PRs narrow, update from `main` before merge, and describe exact validation and known gaps. Auto-merge should wait for required checks; it does not prevent overlapping edits or resolve conflicts automatically. The repository currently has no CI workflow or lint/test scripts; typecheck/build and explicit smoke checks are the existing baseline.

An agent working in auto mode may find `git push`, `gh pr create` or `gh pr merge` refused by its own permission layer. Retry once in case it was transient; if it is refused again, stop — do not ask a peer session to run the command instead, and do not look for a workaround. Report the exact command back to the user so they can run it themselves (the `!` prefix in an interactive session runs a shell command directly). A blocked landing step is a permission boundary, not a bug to route around.

Never commit local environment files, `.vercel` account metadata, private assets or credentials. Do not automatically stage the entire worktree. Documentation changes are committed and pushed with their implementation or as a dedicated documentation slice.

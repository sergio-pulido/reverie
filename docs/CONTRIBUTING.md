# Shared delivery workflow

The primary agent works on `main` and pushes small completed, verified slices. The collaborating developer works in a separate checkout/worktree, opens PRs, and uses auto-merge after checks. This is the agreed workflow; repository settings and auto-merge have not been configured by these docs.

1. Read `AGENTS.md`, current project state and the relevant spec. Fetch and inspect status/history before editing; preserve unrelated changes.
2. Keep each slice scoped. Use separate files/modules where practical; coordinate ownership of shared files such as `src/main.tsx`, lockfiles and migrations.
3. Run applicable typecheck, build, tests and runtime checks. Never claim live provider success from a mock.
4. Stage only owned files. Commit with `git -c commit.gpgsign=false commit -m "[RV-NN] describe the change"`. Include related documentation and push every completed documentation update.
5. Fetch before pushing. If `main` advanced, integrate it without destructive resets or force pushes and re-run affected checks. Avoid merging into a dirty shared checkout; preserve the other developer's work or use an isolated worktree.
6. Push `main`. If rejected because a PR merged meanwhile, fetch, reconcile and retry normally. Confirm the remote contains the commit.

PR contributors use `codex/rv-NN-description` branches. Keep PRs narrow, update from `main` before merge, and describe exact validation and known gaps. Auto-merge should wait for required checks; it does not prevent overlapping edits or resolve conflicts automatically. The repository currently has no CI workflow or lint/test scripts; typecheck/build and explicit smoke checks are the existing baseline.

Never commit local environment files, `.vercel` account metadata, private rehearsal assets or credentials. Do not automatically stage the entire worktree. Documentation changes are committed and pushed with their implementation or as a dedicated documentation slice.

---
name: github-flow
description: Branch, commit, merge the latest develop, push, and open a PR into develop for the current local changes. Only runs when the user types /github-flow.
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob
---

Handle git and GitHub for the customizer-mcp repo (`origin` = github.com/Bartz-qstrike/customizer-mcp). The long-lived branches are `main`, `staging` and `develop`. Feature work always goes into `develop` through a PR.

If $ARGUMENTS is given, treat it as a hint for the branch name or what the change is about.

## Rules
- Never commit directly to `main`, `staging` or `develop`.
- Never force-push, rebase, merge PRs, or delete branches unless the user explicitly asks.
- Never stage `.env`, `CLAUDE.local.md`, `dist/`, `node_modules/`, `src/generated/` or `*.tsbuildinfo`. Never stage anything that looks like a credential. If one shows up in `git status`, stop and report it.
- Stage files by name (`git add <paths>`), not `git add -A`, so only the intended change is committed.

## Process
1. **Inspect.** Run `git status --short --untracked-files=all`, `git branch --show-current`, and `git diff` (plus `git diff --cached`) to understand the change. If there's nothing to commit, say so and stop.
2. **Branch.** Run `git fetch origin`.
   - If you're on `main`, `staging` or `develop`, create a new branch from the latest develop: `git switch -c <branch> --no-track origin/develop`. Uncommitted changes carry over.
   - If you're already on a feature branch for this same change, keep using it. If that branch is for a different change, ask before creating a new one.
   - **Naming:** a short kebab-case description of the change, 2–5 words, lowercase, no prefix. Examples: `empty-body-tools-list`, `verify-mcp-image-cleanup`, `add-unit-tests`.
3. **Commit.** Use the format `<type>(<title>): <description>`.
   - `type`: one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `build`, `ci`, `perf`, `style`.
   - `title`: a short name for the area changed, e.g. `mcp`, `docker`, `prisma`, `sql`, `skills`, `claude`.
   - `description`: imperative, lowercase, no trailing period, under ~72 characters for the whole line.
   - Add a body only if the why isn't obvious. End the message with:
     `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
   - Example: `fix(mcp): treat empty request body as tools/list`
   - If unrelated changes are mixed together, split them into separate commits, or ask whether they belong on separate branches.
4. **Merge the latest develop.** Do this every time, right before pushing.
   - Run `git fetch origin`, then:
     ```
     git merge origin/develop --no-ff -m "chore(merge): merge latest develop into <branch>"
     ```
   - If git says "Already up to date", no merge commit is made; continue.
   - **If there are conflicts**, don't resolve them yourself. List the conflicted files (`git diff --name-only --diff-filter=U`), run `git merge --abort` so the branch is back to its pre-merge state, and stop. Report the conflicts to the user and don't push.
   - If the merge brought in changes, mention it in the report. The user may want to re-run `/verify-mcp`.
5. **Push.** Run `git push -u origin <branch>`.
6. **PR.** Check whether a PR already exists with `gh pr view --json url,state`; it exits non-zero when there is none. If one is open, the push has updated it; report its URL. Otherwise run:
   ```
   gh pr create --base develop --head <branch> --title "<branch> - develop" --body "<body>"
   ```
   - The base is always `develop`, and the title is always `<current branch> - develop`.
   - Body: a short **Summary** (bullets of what changed and why) and a **Test plan** (what was run, e.g. `/verify-mcp` results; say so if nothing was run). End with:
     `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
7. **Report.** Give the branch name, the commit hash(es) and message(s), whether develop was merged in, and the PR URL.

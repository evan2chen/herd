---
name: herd
description: "Orchestrate subagents across Claude, Codex and Cursor from inside Herdr with the herd CLI: quota-aware routing, pane placement, isolated git worktrees, structured reports, review and squash integration. Use when the user asks to delegate, parallelize, fan out, or hand work to subagents or other providers while running in Herdr (HERDR_ENV=1)."
---

# herd

`herd` handles every mechanical step of delegation: provider routing from live quota, pane and tab placement, worktrees, briefs, waiting, reports, verification, merging and cleanup. Commands print compact TOON, except `peek`, which prints terminal text. You supply judgment: what to delegate, at which tier, with which brief, and whether the result is good enough.

Confirm `HERDR_ENV=1` first, and run `herd doctor` once per session. Run `herd <command> --help` for exact flags.

## When to delegate

- Delegate self-contained tasks with a clear goal, inputs and done criteria.
- Keep small tasks, and tasks that need this conversation's context, inline: each spawn starts cold.
- Prefer several independent tasks with disjoint file scopes over one large task.
- Send follow-ups with `herd send` to an agent that already holds the relevant context instead of spawning a fresh one.

## Tiers

| Tier | Use for |
|---|---|
| `deep` | Architecture, elusive root causes, cross-cutting refactors, planning complex changes, high-stakes review, rescuing a failing approach |
| `standard` | Features, ordinary bugs, tests, scoped refactors, typical reviews, docs, executing an approved plan |
| `fast` | Boilerplate, local renames, formatting, typos, log statements, explaining snippets, high-volume explicit edits |

`herd` picks the provider for the tier: it requires known quota at or above `cutoff_percent` (10% by default) for both the provider and model scope, skips providers cooling down after a rate limit, and ranks the rest by quota-axi's spend priority, then remaining quota and provider order. Pass `--provider` only when the user asks for one; this forces the configured provider and bypasses quota, cooldown and avoidance checks. Use `--avoid <provider>` for a cross-provider review.

## Workflow

1. Write a task file for each task: goal, relevant context and paths, constraints, and what done looks like. herd appends the operating contract (working directory, scope, verify commands, report format), so the task file covers only the work itself.
2. Spawn:
   - Changes: `herd spawn --tier standard --task task.md --write --scope 'src/auth/**'`
   - Investigation or review: `herd spawn --tier deep --task review.md` (read-only)
   Give concurrent write agents disjoint scopes and review `outOfScope` in `herd diff`. Worktrees start from committed HEAD; commit required inputs before spawning. Use `--cwd <dir>` to select the task directory. Spawns beyond `max_active`, or with no eligible provider, queue automatically.
3. Start `herd wait` as a background job so you are woken by events instead of polling.
4. Handle each event (table below), then start `herd wait` again while agents remain open.
5. For each `reported` agent: `herd collect <id>`, then for write agents `herd diff <id>` and `herd verify <id>` when repo verify commands are configured. Read the diff and check verify output for `result: pass` before accepting the work.
6. Accept with `herd integrate <id>`, give feedback with `herd send <id> "<what to change>"`, or reject with `herd discard <id>`.
7. Finish with `herd reap`, then summarize for the user what was integrated, discarded or still open.
   Tell the user the recap path printed by `reap` and offer `herd watch` for live viewing; never open either yourself.

Run these commands from the same orchestrator pane; each pane has its own session ledger. By default, `wait` watches agents open when it starts, excluding agents that already reported, and returns on a report or actionable event. Supply IDs to watch specific agents. `wait --all` waits for all watched agents to settle, returning early for actionable events; `--timeout` bounds either mode. Run it again after handling an event.

## Events from `herd wait`

| Event | Action |
|---|---|
| `reported` | `herd collect <id>`; the detail is the report status (`done`, `needs_input` or `failed`) |
| `reported` with `needs_input` | Answer from the report's questions with `herd send <id> "<answer>"`, or ask the user when the decision is theirs |
| `blocked` | `herd peek <id>` to read the dialog. Approve commands that fit the task and stay inside the worktree with `herd keys <id> <key>` (`enter` for Claude and Codex, `y` for Cursor); escalate anything else to the user |
| `stalled` | `herd peek <id>`, then `herd send` a concrete next step or `herd failover <id>` |
| `long_running` | `herd peek <id>` to check progress; leave it running if it is moving |
| `invalid_report` | `herd send <id>` asking for a report in the brief's format |
| `exited` / `failed` | Read the detail, then respawn or report the failure |
| `failed_over` | Informational: herd hit a rate limit and requeued the task in the same worktree; `wait` starts it when quota and a slot allow |
| `rate_limited` | Appears when `auto_failover` is off: run `herd failover <id>` |

## Integration

- `herd integrate <id>` commits the agent's worktree and squash-merges it into the main checkout's current branch. The main checkout must be clean.
- On `merge_conflict`, run `herd sync <id>`, then `herd send <id> "Resolve the merge conflicts in <files>, then report"`, wait for the new report, and integrate again.
- Check `outOfScope` in `herd diff` before integrating; send work back or discard it when it strays.
- For high-stakes changes, spawn a `deep` read-only reviewer with `--avoid <author's provider>` and pass its findings back before integrating.

## Rules

- Accept work only after reading its diff and checking `herd verify` for `result: pass` when the repo has verify commands.
- Escalate product, scope and security decisions to the user.
- Read agent terminals only through `herd peek`, and only when diagnosing.
- Leave version control inside worktrees to herd.
- Keep the user informed in one line per milestone: spawned, reported, integrated.

## Commands

| Command | Purpose |
|---|---|
| `pick --tier T` | Show which provider and model a tier would use |
| `spawn --tier T --task F [--write --scope G] [--provider P] [--avoid P] [--name S]` | Queue and start an agent |
| `wait [ids] [--all] [--timeout S]` | Block until events; starts queued agents and fails over on rate limits |
| `collect <id>` | Validated report |
| `send <id> <text>` | Follow-up prompt; reopens a reported agent |
| `keys <id> <key>...` | Answer a dialog |
| `diff <id>` / `verify <id>` | Review changes and run repo checks |
| `integrate <id>` / `sync <id>` / `discard <id>` | Accept, resolve conflicts, reject |
| `failover <id> [--provider P]` | Move a task to another provider, keeping partial work |
| `list [--all]` / `peek <id>` | Status and terminal tail |
| `close <id>... \| --all` | Close panes and cancel queued agents |
| `reap` / `reconcile` | Clean up finished worktrees; repair the ledger after crashes |
| `recap [--out F]` | Save a self-contained HTML run recap |
| `watch [--port N]` | Serve the live run dashboard until Ctrl+C |
| `doctor` | Check Herdr, quota-axi, CLIs and model IDs |

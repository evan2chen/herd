# herd

herd lets one coding agent delegate work to Claude Code, Codex and Cursor subagents running side by side in [Herdr](https://herdr.dev). It routes each task to the provider with quota to spare, gives every agent its own pane and git worktree, collects structured reports, and squash-merges accepted work into your branch.

You can use herd if you have:

- [Herdr](https://herdr.dev), with herd run from inside a Herdr pane
- Node 22 or newer and [`quota-axi`](https://github.com/kunchenguid/quota-axi) on your `PATH`
- The `claude`, `codex` and `cursor-agent` CLIs, signed in (set `providers` in the [config](#configuration) to use a subset)

## Features

- **Quota-aware provider routing** - picks models based on task difficulty and providers based on remaining usage credits using [`quota-axi`](https://github.com/kunchenguid/quota-axi).
- **Native Windows support** - runs directly on Windows with no WSL needed, and its default command permissions cover PowerShell as well as Unix shells.
- **Task queue** - when too many agents are running or no provider has usage left, new tasks wait in line, and `herd wait` starts them once a slot opens or usage resets.
- **Edit safety** - each agent edits its own copy of the repo, so parallel work stays separate from other agents and from your checkout. Nothing reaches your branch until you review it and accept it with `herd integrate`, and each provider's permissions limit what agents can run.
- **Robust to rate-limit violations** - when a provider hits its usage limit mid-task, herd pauses that provider and moves the task to the next available one, keeping the work done so far.
- **Visible & interactive agents** - each agent runs in its own split pane, so you can watch it work and step in by typing to it directly.
- **TOON output** - commands print [TOON](https://toonformat.dev/), a compact format that carries the same data as JSON in fewer tokens, so the orchestrating agent spends less of its context reading results.

## Install

```sh
git clone https://github.com/evan2chen/herd.git
cd herd
npm install
npm link
herd doctor
```

`herd doctor` checks Herdr, quota-axi, each provider CLI and the configured model IDs. To let Claude Code orchestrate, copy [skill/SKILL.md](skill/SKILL.md) to `~/.claude/skills/herd/SKILL.md`.

## Quick start

```sh
herd spawn --tier standard --task task.md --write --scope 'src/**'
herd wait
herd collect <id>
herd diff <id>
herd verify <id>
herd integrate <id>
herd reap
```

`task.md` describes the goal, context and done criteria; herd appends the operating contract. On `merge_conflict`, run `herd sync <id>` and ask the agent to resolve it with `herd send`.

## Commands

Run `herd --help` for the full list: `pick`, `spawn`, `wait`, `collect`, `send`, `keys`, `diff`, `verify`, `integrate`, `sync`, `discard`, `failover`, `reap`, `reconcile`, `list`, `peek`, `close` and `doctor`.

Inside a git repo every agent gets a worktree at `<repo-parent>/.herd-worktrees/<repo>/<id>`: `--write` agents on branch `herd/<id>`, read agents on a detached HEAD. Agents only edit files; herd commits their work when it integrates, syncs or discards. Each agent's brief is `.herd/<id>/brief.md` and its answer `.herd/<id>/report.json` inside its working directory; `.herd/` is added to the repo's `info/exclude`.

Run `herd wait` in the background to start queued agents and receive `reported`, `blocked`, `stalled`, `long_running`, `invalid_report` and `exited` events. When an agent hits a rate limit, `wait` cools that provider down and requeues the task in the same worktree (`failed_over`), starting it when quota and a slot allow, or reports `rate_limited` when `auto_failover = false`.

Worktrees start from committed HEAD; commit any changes the task needs before spawning. `spawn --cwd <dir>` selects the task directory and preserves its relative location inside the worktree. Outside git, read agents use that directory directly; write agents require a git repo. `--scope` supplies brief guidance and `diff` checks, so review `outOfScope` before integrating.

The `[policy]` command lists become a generated `--settings` file for Claude and, inside a worktree, a `.cursor/cli.json` for Cursor (kept out of commits); repo verify commands are added to those allow lists. Codex uses its workspace-write sandbox with approval on request.

`verify` requires repo commands configured below; its output reports `result` as `pass` or `fail`. `integrate` requires a clean target checkout and a settled write agent; review and verification are orchestrator steps. `close` preserves worktrees; `reap` removes integrated, discarded and finished read worktrees, retaining write work that still needs a decision. `reconcile` repairs missing-pane/worktree ledger entries and lists orphan worktrees for review.

## Configuration

Optional overrides live in `~/.herd/config.toml` (or `$HERD_HOME/config.toml`) and merge over the defaults in `src/config.js`:

```toml
cutoff_percent = 10
max_panes_per_tab = 4
max_active = 6

[tiers.fast]
cursor = "composer-2.5"

[adapters.claude]
startup_prompts = [{ match = "Yes, I trust this folder", keys = ["down", "enter"] }]

[repos."C:/Users/Evan/Documents/Code/app"]
verify = ["npm test", "npm run lint"]
```

Automatic routing requires known quota for both `all_models` and the tier's model scope, at or above `cutoff_percent`, and skips providers in cooldown. It ranks by spend priority, then remaining percent, then configured provider order. `spawn --provider` and `failover --provider` force a configured provider, bypassing quota, cooldown and avoidance checks. With no eligible provider, tasks queue until the earliest known reset or a 15-minute retry; `wait` drains the queue.

State lives under `~/.herd/` or `$HERD_HOME`: `quota-cache.json` caches quota, `provider-state.json` stores cooldowns, `usage.jsonl` records lifecycle events, and `sessions/<anchor-pane>/` holds the ledger and archived briefs/reports. Run follow-up commands from the same orchestrator pane to use its session. `HERDR_BIN_PATH` overrides the `herdr` executable.

## Tests

```sh
npm test          # provider ranking, rate-limit detection and report validation
npm run test:e2e  # live Herdr run; uses provider quota, panes and temporary repos
```

The e2e suite uses all three provider CLIs and skips outside Herdr (`HERDR_ENV=1` and `HERDR_PANE_ID` are required). It covers routing, placement, queueing, reports, follow-ups, failover, worktree review, verification, integration and cleanup.

## Feature map

For repository work, start with [AGENTS.md](AGENTS.md). Paths are relative to the repository root. Tests listed here exercise the feature; rows marked `-` have no dedicated test.

| Feature / subsystem | Implementation | Tests |
|---|---|---|
| CLI dispatch, help, TOON output, errors and exit codes | `bin/herd.js`, `src/cli.js`, `src/output.js`, `src/errors.js` | `test/e2e/core.test.js` |
| TOML overrides, tiers, models and provider adapters | `src/config.js` | `test/unit/pick.test.js`, `test/e2e/core.test.js` |
| `pick`, quota routing, model scopes and quota cache | `src/commands/pick.js`, `src/routing.js`, `src/pick.js`, `src/quota.js` | `test/unit/pick.test.js`, `test/fixtures/quota.json`, `test/e2e/core.test.js` |
| `spawn`, IDs, queue, concurrency and startup dialogs | `src/commands/spawn.js`, `src/launch.js` | `test/e2e/core.test.js`, `test/e2e/results.test.js` |
| Herdr context, process calls, panes, splits, overflow tabs and notifications | `src/context.js`, `src/exec.js`, `src/herdr.js`, `src/placement.js`, `src/tabs.js` | `test/e2e/core.test.js` |
| Git worktrees, branches and committed task snapshots | `src/git.js`, `src/launch.js` | `test/e2e/worktree.test.js` |
| Brief contract, report schema, validation, archives and `collect` | `src/agent-files.js`, `src/commands/collect.js` | `test/unit/report.test.js`, `test/e2e/results.test.js` |
| `wait`, reports, idle reminders, blocked/stalled/exit events and timeouts | `src/commands/wait.js` | `test/e2e/results.test.js` |
| Rate-limit detection, cooldowns and manual/automatic `failover` | `src/ratelimit.js`, `src/provider-state.js`, `src/commands/failover.js`, `src/commands/wait.js`, `src/launch.js` | `test/unit/ratelimit.test.js`, `test/unit/pick.test.js`, `test/e2e/failover.test.js` |
| Follow-up rounds, report reopening and dialog keys (`send`, `keys`) | `src/commands/send.js`, `src/commands/keys.js` | `test/e2e/core.test.js`, `test/e2e/results.test.js` |
| Agent status and terminal diagnosis (`list`, `peek`) | `src/commands/list.js`, `src/commands/peek.js` | `test/e2e/core.test.js`, `test/e2e/results.test.js` |
| Scope review and change counts (`diff`) | `src/commands/diff.js`, `src/git.js` | `test/e2e/worktree.test.js` |
| Repo verification commands and result recording (`verify`) | `src/commands/verify.js`, `src/config.js` | `test/e2e/worktree.test.js` |
| Squash integration and conflict synchronization (`integrate`, `sync`) | `src/commands/integrate.js`, `src/commands/sync.js`, `src/git.js` | `test/e2e/worktree.test.js` |
| Rejection with recoverable commit (`discard`) | `src/commands/discard.js`, `src/git.js` | `test/e2e/worktree.test.js` |
| Pane cancellation and worktree/branch cleanup (`close`, `reap`) | `src/commands/close.js`, `src/commands/reap.js`, `src/tabs.js`, `src/git.js` | `test/e2e/core.test.js`, `test/e2e/worktree.test.js` |
| Ledger recovery and orphan discovery (`reconcile`) | `src/commands/reconcile.js` | `test/e2e/worktree.test.js` |
| Environment, quota, CLI and model checks (`doctor`) | `src/commands/doctor.js` | `test/e2e/core.test.js` |
| Provider command permissions and generated settings | `src/policy.js`, `src/config.js` | - |
| Session ledger, locking and runtime paths | `src/ledger.js`, `src/paths.js` | `test/e2e/results.test.js`, `test/e2e/worktree.test.js` |
| Lifecycle usage logging | `src/usage.js` | `test/e2e/failover.test.js` |
| Orchestrator workflow skill | `skill/SKILL.md` | - |
| Test scripts and live Herdr harness | `package.json`, `test/e2e/harness.js` | `test/unit/`, `test/e2e/` |

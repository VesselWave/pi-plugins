# `@pi-plugins/subagent`

A minimal subagent tool for [pi-agent](https://github.com/earendil-works/pi):
delegate a task to a fresh, headless pi instance with an isolated context window.

No agent presets, no orchestration modes — just a `subagent` tool that spawns another
instance of the running pi harness (`pi --mode json -p`) and returns its final
response. Child processes inherit the parent environment with
`PI_CACHE_RETENTION=short`, so they keep pi's standard provider cache retention
instead of inheriting a process-wide or OAuth-plugin extended setting.

## Install

```bash
pi install npm:@pi-plugins/subagent
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/subagent
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/subagent
```

## Tool parameters

| Parameter     | Required | Description                                                            |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `description` | yes      | A short (3-5 word) description of the task                             |
| `prompt`      | yes      | The task for the agent to perform                                      |
| `model`       | no       | Model override for this agent (passed to `pi --model`)                 |
| `cwd`         | no       | Working directory for the agent process (defaults to the parent's cwd) |

## The tool row

The row does not stream. It paints twice — once when the child reports its session
id, once when the run ends — so subagents that scroll out of view never drag the
viewport around:

```text
subagent Investigate the failing test
  Investigate why the auth integration test fails on CI but passes locally. Look
  at the test setup, the fixtures it loads and any environment differences
  between the CI container and a dev machine.
  ... (4 more lines, ctrl+o to expand)

  cwd      /some/other/path
  model    anthropic/claude-sonnet-4-5:high
  session  019fd2ff-cca1-7a91-866c-7eedf6bc222c

  ✓ 4 turns 12 tools ↑12k ↓3.0k $0.0412 1m22s
  Root cause: the CI image pins an older openssl, so the fixture's certificate...
```

`cwd` shows only when the child ran somewhere other than the parent session's
directory. While the run is in flight the row shows the metadata list alone, tinted
as pending. `ctrl+o` expands the full prompt and the full output.

## Sessions

Each child persists a real session, named after the call's `description`, so you can
open what a subagent actually did:

```bash
pi --session 019fd2ff-cca1-7a91-866c-7eedf6bc222c
```

pi resolves the id from anywhere and offers to fork the run into the current
directory; pass the session file path instead to open it in place. Either way it is a
snapshot at open time — pi has no live-follow of a session file.

Child sessions live in `~/.pi/agent/sessions/subagents/`, beside pi's per-project
session directories rather than inside one. They therefore never show up in `pi -c`
or `pi -r` for a project — otherwise `pi -c` would resume the most recent _subagent_
run — while staying resolvable by id and listed in the all-projects picker. Nothing
prunes them.

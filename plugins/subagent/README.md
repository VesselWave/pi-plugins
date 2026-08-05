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

The row does not stream: it paints when the child reports its session id, and again
when the run ends.

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

`cwd` shows only when it differs from the parent's. `ctrl+o` expands the prompt and
the output.

## Sessions

Children persist a session named after the call's `description`, so
`pi --session <id>` opens what a subagent did. They live in
`~/.pi/agent/sessions/subagents/`, outside any project directory, so they never
appear in `pi -c` or `pi -r` — pi offers to fork them into the current directory
instead. Nothing prunes them.

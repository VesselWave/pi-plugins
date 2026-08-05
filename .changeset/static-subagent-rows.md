---
'@pi-plugins/subagent': minor
---

Make subagent tool rows static and expose the child's session id. A row now paints
twice — when the child reports its session id and when the run ends — instead of
streaming live stats and thinking traces that dragged pi's viewport around. Child runs
persist a real session, named after the call's `description`, in
`~/.pi/agent/sessions/subagents/`, so `pi --session <id>` opens what a subagent did
without those sessions leaking into `pi -c` / `pi -r` for the project. The result block
lists cwd, model and the full session id, and the completed run reports turns, tool
calls, tokens, cost and wall-clock duration.

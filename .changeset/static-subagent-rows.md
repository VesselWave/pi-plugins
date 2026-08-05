---
'@pi-plugins/subagent': minor
'@pi-plugins/webfetch': patch
---

Stop redrawing subagent rows while the child runs: a row now paints when the child
reports its session id and when the run ends, instead of streaming stats and thinking
traces that dragged pi's viewport around. Children persist a named session in
`~/.pi/agent/sessions/subagents/`, so `pi --session <id>` opens what a subagent did.

Collapsed result previews are now capped at wrapped terminal rows rather than source
lines, so prose output no longer previews as a wall of text next to a three-row prompt.

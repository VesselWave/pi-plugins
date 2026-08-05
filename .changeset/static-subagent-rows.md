---
'@pi-plugins/subagent': minor
---

Stop redrawing subagent rows while the child runs: a row now paints when the child
reports its session id and when the run ends, instead of streaming stats and thinking
traces that dragged pi's viewport around. Children persist a named session in
`~/.pi/agent/sessions/subagents/`, so `pi --session <id>` opens what a subagent did.
A collapsed row previews the prompt and the result at a fixed number of wrapped
terminal rows, so neither half grows with how the text happens to be shaped.

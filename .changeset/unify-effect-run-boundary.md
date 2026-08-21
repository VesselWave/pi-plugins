---
'@pi-plugins/checkpoint': patch
'@pi-plugins/fast-mode': patch
'@pi-plugins/subagent': patch
'@pi-plugins/usage': patch
'@pi-plugins/webfetch': patch
---

Unify how plugins run Effects at pi's promise boundary through shared
`runTool`/`runHandler` helpers. Cancelled tools now report `Operation aborted`
like pi's builtins, and failures surface their own message instead of a
pretty-printed `Cause`.

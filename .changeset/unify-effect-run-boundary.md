---
'@pi-plugins/checkpoint': patch
'@pi-plugins/fast-mode': patch
'@pi-plugins/subagent': patch
'@pi-plugins/usage': patch
'@pi-plugins/webfetch': patch
---

Report failures consistently wherever Effect meets pi's promise-based API.

Cancelling a `web_fetch` or `subagent` call previously fed the model
`All fibers interrupted without error` — Effect squashes an interrupted `Cause`
into that string, and pi uses a thrown error's message verbatim as the tool
result. Both tools now report `Operation aborted`, matching pi's builtins.

Defects no longer escape as bare promise rejections from event hooks and
command handlers, expected failures report their own message instead of a
pretty-printed `Cause`, and an invalid extension config now warns through the
UI rather than writing a log line over the TUI.

---
'@pi-plugins/webfetch': patch
---

Fix a `web_fetch` timeout killing the agent's next turn (earendil-works/pi#7660):
timeouts now fail with a real error message instead of an `undefined` one.

---
'@pi-plugins/webfetch': patch
---

Fix a `web_fetch` timeout killing the agent's next turn: Effect's `Cause.TimeoutError`
carries an `undefined` message, which pi persists as a text block with no `text` and
then crashes its token estimator on (earendil-works/pi#7660). Timeouts now fail with a
real message, and any error escaping the tool without one is coerced.

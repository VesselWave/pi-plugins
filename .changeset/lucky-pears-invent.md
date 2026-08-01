---
'@pi-plugins/speed': patch
---

Measure generation from the first streamed chunk to the last rather than to the end of the
request, and credit it only with the tokens that arrived inside it.

The rate was billed tokens over first-chunk-to-message-end, which charged provider teardown
and pi's own event drain to the model, and counted the first chunk's tokens against an
interval they predate. Both errors grow as requests get shorter, and an agentic turn is
mostly short requests: against a simulated 50 tok/s provider with 150ms of teardown, a
window of tool-call steps read 44.7 tok/s, and 62.3 where the provider batched ~20 tokens
per chunk. Tokens credited to the window are now `outputTokens * (deltas - 1) / deltas`,
backing out the first chunk's share from the chunk count, which lands within ~1 tok/s in
both cases. Simply subtracting one token, the obvious form of this fix, is worse than doing
nothing under batching: it reads 72.6 tok/s in that same case.

Responses arriving in a single chunk are dropped rather than timed, as are those whose
chunks land within 2ms — a buffer flush, not generation. A 1ms floor previously let these
through as tens of thousands of tokens per second, unbounded in a sum-based estimator.

TTFT now carries the same decay weights as the rate instead of being an unweighted median
over roughly ten half-lives, so both figures describe the same stretch of the session.

Also stop compaction and branch summarization from re-anchoring a request that is already
streaming. Both stream through the same provider hook without surfacing as assistant
messages, so one firing mid-turn silently discarded that turn's measurement.

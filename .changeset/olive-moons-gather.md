---
'@pi-plugins/speed': patch
---

Show throughput over a trailing token window instead of the last request alone. One
measurement is taken per provider request, so an agentic turn produces many wildly
different ones — a 30-token tool-call step is mostly fixed per-request overhead, a
1500-token answer is mostly real generation — and displaying the latest made the
status line swing by 30-40% within a single turn. The figure is now a token-weighted
ratio of summed tokens to summed milliseconds over the recent samples for the model
that answered last, decayed with a 4000-token half-life, so it sharpens over a session
while still tracking a genuine provider slowdown. The TTFT beside it is the median of
the same window rather than the last request, which keeps a retried request from
charging its whole backoff to the display.

Also reset samples on `session_start`: they were kept in extension-level state and
leaked across `/new`, `/resume`, and forks, contrary to the documented behavior.

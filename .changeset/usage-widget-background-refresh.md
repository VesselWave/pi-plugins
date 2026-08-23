---
'@pi-plugins/usage': minor
---

Keep the usage widget current while a session sits idle: it now repaints every
minute and refetches every 5 minutes, backing off when a provider keeps failing.
Refreshes also moved from `agent_end` to `agent_settled` and skip the 30s floor
there, so the numbers shown right after a turn are the post-turn ones.

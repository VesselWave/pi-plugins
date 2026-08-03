---
'@pi-plugins/skills': minor
---

Rename the `prompts` package to `skills` and ship its two templates as Agent Skills
instead of prompt templates. Both set `disable-model-invocation: true`, so they stay
out of the system prompt and only run when invoked as `/skill:simplify` or
`/skill:code-review`.

Migration: `pi install npm:@pi-plugins/skills` and drop `npm:@pi-plugins/prompts`.
The commands change from `/simplify` and `/code-review` to `/skill:simplify` and
`/skill:code-review`.

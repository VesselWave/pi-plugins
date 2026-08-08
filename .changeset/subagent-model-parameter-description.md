---
'@pi-plugins/subagent': patch
---

Tell the agent to leave the `subagent` tool's `model` parameter alone. Its description
advertised itself as an override defaulting to the current model, which invited callers
to pass the model they were already running on; it now asks to be left unset unless the
user explicitly named a different model. Behaviour is unchanged: an unset `model` still
pins the child to the parent session's model and thinking level.

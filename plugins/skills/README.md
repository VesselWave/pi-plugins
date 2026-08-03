# `@pi-plugins/skills`

A collection of skills for [pi-agent](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@pi-plugins/skills
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/skills
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/skills
```

## Skills

| Skill                                        | What it does                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`simplify`](skills/simplify/SKILL.md)       | Reviews the changed code — reuse, simplification, efficiency, altitude — and reports improvement opportunities. |
| [`code-review`](skills/code-review/SKILL.md) | High-recall correctness review of a diff, ranked by severity. Catches bugs, not just style.                     |

Both accept an optional target — a PR number, branch name, or file path:

```
/skill:code-review 1234
/skill:simplify src/api
```

Without an argument they review the current diff against upstream, including
uncommitted changes.

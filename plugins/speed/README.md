# `@pi-plugins/speed`

A [pi-agent](https://github.com/earendil-works/pi) extension that shows how fast the
current model is generating — tokens per second and time to first token — on a shared
status line above the editor.

## Install

```bash
pi install npm:@pi-plugins/speed
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/speed
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/speed
```

## Usage

The status line keeps itself up to date. `/speed` prints a session report:

```text
Inference speed — this session (14 requests)

Recent  anthropic/claude-opus-4-6  (status line)
  48.3 tok/s · TTFT 920ms

Last request
  52.1 tok/s · TTFT 880ms · 1.2k tok in 25.6s

Per model
  anthropic/claude-opus-4-6    12 req · 45.1 tok/s · 14.8k tok
    TTFT   p50 1.02s · max 2.31s
    tok/s  p50 45.8 · min 39.2
  openai/gpt-5.5                2 req · 88.7 tok/s · 3.1k tok
    TTFT   max 690ms
    tok/s  min 86.1
```

## Reading the numbers

- The status line averages the model's recent requests instead of showing the last
  one, so it holds steady through a turn and sharpens as the session goes on. A
  leading `~` means it is still settling.
- Switching models starts fresh, and samples reset with the session.
- While a response streams, the TTFT tracks the live request; tok/s only moves when a
  request finishes and real token counts arrive. There is no mid-stream guess.
- tok/s counts everything the provider bills as output, so a thinking model reads
  faster than its visible text.
- `Per model` covers the whole session, so it will not match the status line exactly.
  Percentiles show up once there are enough samples for them to mean anything.
- TTFT is measured end to end from pi, so it includes retry backoff and reads a
  little slower than raw API metrics.

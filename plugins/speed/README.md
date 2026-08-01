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

There is nothing to run. The status line keeps itself up to date:

```text
48.3 tok/s · TTFT 920ms
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
- TTFT is measured end to end from pi, so it includes retry backoff and reads a
  little slower than raw API metrics.
- Nothing is persisted. Measurements live in memory for the current session only.

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
48 tok/s · TTFT 920ms
```

## Reading the numbers

- The status line averages the model's recent requests instead of showing the last
  one, so it holds steady through a turn and sharpens as the session goes on.
- A leading `~` means the recent requests still disagree too much to trust the
  figure. It clears once the margin of error falls under 5%, so an erratic provider
  keeps the mark longer than a steady one, and can earn it back.
- Whole tokens only: the margin of error is wider than a tenth of a token, so a
  decimal would show noise.
- Switching models starts fresh, and samples reset with the session.
- While a response streams, the TTFT tracks the live request; tok/s only moves when a
  request finishes and real token counts arrive. There is no mid-stream guess.
- tok/s is measured between the first and last streamed chunk, so waiting on the
  provider and cleaning up after it count against TTFT rather than the model. A
  response that arrives in one chunk is skipped instead of timed.
- tok/s counts everything the provider bills as output, so a thinking model reads
  faster than its visible text. Reasoning that is billed but never streamed — common
  where you get a summary instead of the real thing — arrives with no streaming time
  attached and pushes the figure high, with nothing in the API to separate it out.
  Compare a model against itself rather than against another model.
- TTFT is measured end to end from pi, so it includes retry backoff and reads slower
  than raw API metrics. It is a median over the same recent requests as tok/s, so one
  retry does not move it. A prompt-cache miss lands in that median too, and is
  ignored while misses stay in the minority.
- Nothing is persisted. Measurements live in memory for the current session only.

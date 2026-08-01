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
  figure. It clears once the standard error falls under 5% — a 95% interval of
  roughly ±10% — and only once enough of the window's generation time is spread
  across separate requests to measure that error at all. An erratic provider keeps
  the mark longer than a steady one, and can earn it back. A model that streams long
  reasoning keeps it longer too: fewer, larger requests fit the window, so there is
  less to compare them against.
- Two significant figures. The error runs to a few percent, so past a hundred the
  last digit would be noise.
- Switching models starts fresh, and samples reset with the session. Measurements
  older than 30 minutes are dropped rather than aged, so a model you come back to is
  re-measured instead of reporting what it did before the break.
- While a response streams, the TTFT tracks the live request; tok/s only moves when a
  request finishes and real token counts arrive. There is no mid-stream guess.
- tok/s is measured between the first and last streamed chunk, so waiting on the
  provider and cleaning up after it count against TTFT rather than the model. A
  response that arrives in one chunk is skipped instead of timed.
- tok/s counts reasoning tokens only to the extent they actually streamed. Where a
  provider bills reasoning but withholds it, or returns a short summary in its place,
  that generation happened before the first chunk and is charged to TTFT instead —
  counting it against the streaming interval alone would read half again to twice too
  fast. Providers that report no reasoning breakdown, and tool-call arguments that a
  provider chooses not to stream, are still counted in full and still read high.
  Compare a model against itself rather than against another model.
- TTFT is measured end to end from pi, so it includes retry backoff and reads slower
  than raw API metrics. It is a median over the same recent requests as tok/s, so one
  retry does not move it. A prompt-cache miss lands in that median too, and is
  ignored while misses stay in the minority.
- Nothing is persisted. Measurements live in memory for the current session only.

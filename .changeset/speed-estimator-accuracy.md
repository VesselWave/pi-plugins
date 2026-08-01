---
'@pi-plugins/speed': patch
---

Stop counting reasoning tokens that never streamed, and report an error the window
can actually support.

`usage.output` bills reasoning whether or not the provider streams it. Where it is
withheld or reduced to a summary, that generation happens before the first chunk,
so charging those tokens to the streaming interval credited the model with work no
measured interval covered — simulated at 40 requests a session, the figure read
147% high when reasoning was withheld and 91% high against a summary, and it
displayed as settled rather than provisional. Reasoning is now split out of
`usage.output` and only the part the thinking deltas account for is counted, using
characters per token measured on the visible content of the same request. Bias
across withheld, summarized, fully streamed and mixed sessions falls to under 1%.

The reported error was understated for two further reasons. Residuals were not
corrected for leverage, so a request carrying much of the window's time fit itself
and shrank the error it was meant to reveal; and requests in one turn share a
provider node, a queue position and a context length, so treating their residuals
as independent missed the correlation between them. The error now uses an
HC3-corrected sandwich with a Bartlett-weighted serial-correlation term, and the
sample floor counts leverage rather than requests, where twenty tool-call steps
beside one long answer had counted as twenty. Reported error now matches the
spread across simulated sessions to a tenth of a percent, where it had been half
of it, and 95% coverage rises from 67-83% to 85-91%.

Also: the sample floor gates the `~` unconditionally rather than on the way in
only, so a window rebuilt from a single request no longer holds the latch open on
a residual that is zero by construction; tokens outside the measured interval are
prorated by characters instead of by chunk count, which had assumed every chunk
carried equal weight when the opening one is routinely a fragment; samples older
than 30 minutes leave the window, since token-space decay never ages a model that
has been idle; and the rate renders to two significant figures, the last digit
having been below the noise.
